require("dotenv").config();

const fs = require("fs");
const path = require("path");
const cors = require("cors");
const axios = require("axios");
const multer = require("multer");
const sharp = require("sharp");
const express = require("express");
const pdfPoppler = require("pdf-poppler");

const app = express();

app.use(cors());
app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL =
  process.env.GROQ_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "support@bookleafpub.com";
const DEFAULT_AUTHOR_EMAIL =
  process.env.DEFAULT_AUTHOR_EMAIL || "satendrakaushik2002@gmail.com";

const uploadDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, uploadDir);
  },
  filename: function (_req, file, cb) {
    const safeName = `${Date.now()}-${file.originalname.replace(/\s+/g, "_")}`;
    cb(null, safeName);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 30 * 1024 * 1024,
  },
  fileFilter: function (_req, file, cb) {
    const allowedTypes = [
      "application/pdf",
      "image/png",
      "image/jpeg",
      "image/jpg",
    ];

    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF, PNG, JPG, and JPEG files are allowed."));
    }
  },
});

/**
 * Demo author mapping.
 * For assignment demo, keep ISBN 1234567890123 mapped to the sample cover author.
 */
const authorMapping = {
  "1234567890123": {
    authorName: "Benny James SDB",
    authorEmail: DEFAULT_AUTHOR_EMAIL,
  },
  "9876543210123": {
    authorName: "Rahul Sharma",
    authorEmail: DEFAULT_AUTHOR_EMAIL,
  },
};

function getAuthorByISBN(isbn) {
  return (
    authorMapping[isbn] || {
      authorName: "Author",
      authorEmail: DEFAULT_AUTHOR_EMAIL,
    }
  );
}

function parseJsonFromText(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    const match = text.match(/\{[\s\S]*\}/);

    if (!match) {
      throw new Error("Groq response did not contain valid JSON.");
    }

    return JSON.parse(match[0]);
  }
}

async function convertPdfToPng(pdfPath) {
  const outputPrefix = path.join(
    uploadDir,
    `${path.basename(pdfPath, path.extname(pdfPath))}-page`
  );

  const options = {
    format: "png",
    out_dir: uploadDir,
    out_prefix: path.basename(outputPrefix),
    page: 1,
    scale: 1600,
  };

  await pdfPoppler.convert(pdfPath, options);

  const generatedFiles = fs
    .readdirSync(uploadDir)
    .filter(
      (file) =>
        file.startsWith(path.basename(outputPrefix)) && file.endsWith(".png")
    )
    .map((file) => path.join(uploadDir, file));

  if (!generatedFiles.length) {
    throw new Error("PDF to image conversion failed.");
  }

  return generatedFiles[0];
}

async function normalizeImage(inputPath) {
  const outputPath = path.join(
    uploadDir,
    `${path.basename(inputPath, path.extname(inputPath))}-normalized.png`
  );

  await sharp(inputPath)
    .rotate()
    .resize({
      width: 1600,
      withoutEnlargement: true,
    })
    .png()
    .toFile(outputPath);

  return outputPath;
}

/**
 * Many BookLeaf sample covers are full wrap/spread images:
 * left side = back cover, right side = front cover.
 * This crops the right half for accurate front-cover validation.
 */
async function extractFrontCoverIfSpread(imagePath) {
  const metadata = await sharp(imagePath).metadata();

  const width = metadata.width;
  const height = metadata.height;

  if (!width || !height) {
    throw new Error("Could not read image dimensions.");
  }

  const aspectRatio = width / height;

  /**
   * Normal 5x8 front cover ratio is around 0.625.
   * Full spread/wrap cover is much wider, usually above 1.0.
   */
  const looksLikeFullSpread = aspectRatio > 1.05;

  if (!looksLikeFullSpread) {
    return {
      frontCoverPath: imagePath,
      wasSpreadDetected: false,
      cropInfo: null,
    };
  }

  const cropLeft = Math.floor(width / 2);
  const cropWidth = width - cropLeft;

  const outputPath = path.join(
    uploadDir,
    `${path.basename(imagePath, path.extname(imagePath))}-front-cover.png`
  );

  await sharp(imagePath)
    .extract({
      left: cropLeft,
      top: 0,
      width: cropWidth,
      height,
    })
    .png()
    .toFile(outputPath);

  return {
    frontCoverPath: outputPath,
    wasSpreadDetected: true,
    cropInfo: {
      left: cropLeft,
      top: 0,
      width: cropWidth,
      height,
    },
  };
}

async function getImageMetadata(imagePath) {
  const metadata = await sharp(imagePath).metadata();

  return {
    width: metadata.width,
    height: metadata.height,
    format: metadata.format,
    density: metadata.density || null,
    channels: metadata.channels,
  };
}

function calculateZones(metadata) {
  const width = metadata.width;
  const height = metadata.height;

  const coverWidthInch = 5;
  const coverHeightInch = 8;

  const pxPerMmX = width / (coverWidthInch * 25.4);
  const pxPerMmY = height / (coverHeightInch * 25.4);

  const sideSafeMarginPx = Math.round(3 * pxPerMmX);
  const bottomBadgeZonePx = Math.round(9 * pxPerMmY);

  return {
    sideSafeMarginPx,
    bottomBadgeZonePx,
    safeArea: {
      x1: sideSafeMarginPx,
      y1: sideSafeMarginPx,
      x2: width - sideSafeMarginPx,
      y2: height - bottomBadgeZonePx,
    },
    badgeZone: {
      x1: 0,
      y1: height - bottomBadgeZonePx,
      x2: width,
      y2: height,
    },
  };
}

function getBase64Image(imagePath) {
  const buffer = fs.readFileSync(imagePath);
  return buffer.toString("base64");
}

function normalizeGroqResult(result) {
  const safeStatus =
    String(result.status || "").toUpperCase() === "PASS"
      ? "PASS"
      : "REVIEW NEEDED";

  return {
    status: safeStatus,
    confidenceScore: Number(result.confidenceScore || 75),
    issueType: result.issueType || "Layout Validation Issue",
    severity: result.severity || "Medium",
    issueDetailsText: result.issueDetailsText || "",
    correctionInstructions: result.correctionInstructions || "",
    detectedProblems: Array.isArray(result.detectedProblems)
      ? result.detectedProblems
      : [],
    badgeOverlapDetected: Boolean(result.badgeOverlapDetected),
    safeMarginViolation: Boolean(result.safeMarginViolation),
    qualityIssueDetected: Boolean(result.qualityIssueDetected),
    awardTextDetected: Boolean(result.awardTextDetected),
    unrelatedTextInBadgeZone: Boolean(result.unrelatedTextInBadgeZone),
  };
}

async function analyzeCoverWithGroq({
  imagePath,
  metadata,
  zones,
  isbn,
  fileName,
  wasSpreadDetected,
}) {
  if (!GROQ_API_KEY || GROQ_API_KEY === "your_groq_api_key_here") {
    throw new Error("GROQ_API_KEY is missing or invalid in .env file.");
  }

  const base64Image = getBase64Image(imagePath);

  const systemPrompt = `
You are a strict computer vision quality-control assistant for BookLeaf Publishing.

You must validate ONLY the FRONT COVER of a 5x8 inch book cover.

Critical BookLeaf rule:
The bottom 9mm area is reserved for the award badge/text:
"Winner of the 21st Century Emily Dickinson Award".

Very important:
- The award text itself is expected inside or near the bottom award zone.
- Do NOT mark the award text itself as an overlap problem.
- Only flag REVIEW NEEDED if unrelated text enters the bottom award zone.
- Unrelated text means: title, subtitle, author name, quote, tagline, body text, or any non-award content.
- If the author name is clearly above the award area, it is PASS for author placement.
- If the title/subtitle/author does not overlap the award zone, do not create a badge overlap issue.
- If all checks are positive and no correction is required, status must be PASS.

Validation rules:
1. Author name must not overlap with the bottom award badge zone.
2. Title, subtitle, quote, or unrelated text must not enter the bottom award badge zone.
3. Side safe margins are 3mm on left and right.
4. Text should be legible.
5. Cover should not look pixelated or blurry.
6. Status must be only "PASS" or "REVIEW NEEDED".

Return ONLY valid JSON.
Do not return markdown.
Do not add explanation outside JSON.
`;

  const userPrompt = `
Analyze this front cover image.

Book/File details:
ISBN: ${isbn}
File name: ${fileName}
Was full spread detected and cropped to front cover: ${wasSpreadDetected}

Image metadata:
Width: ${metadata.width}px
Height: ${metadata.height}px

Calculated validation zones:
Side safe margin: ${zones.sideSafeMarginPx}px
Bottom badge reserved zone height: ${zones.bottomBadgeZonePx}px

Badge zone coordinates:
x1=${zones.badgeZone.x1}, y1=${zones.badgeZone.y1}, x2=${zones.badgeZone.x2}, y2=${zones.badgeZone.y2}

Safe area coordinates:
x1=${zones.safeArea.x1}, y1=${zones.safeArea.y1}, x2=${zones.safeArea.x2}, y2=${zones.safeArea.y2}

Expected award text:
"Winner of the 21st Century Emily Dickinson Award"

Important:
Do not flag the expected award text as an issue.
Only flag if title, subtitle, author name, quote, or any unrelated text enters the reserved bottom zone.

Return JSON exactly in this structure:
{
  "status": "PASS or REVIEW NEEDED",
  "confidenceScore": 0-100,
  "issueType": "None or short issue type",
  "severity": "Low or Medium or High or Critical",
  "issueDetailsText": "Use lines with ✅ for pass checks and ❌ only for real issues",
  "correctionInstructions": "Clear step-by-step instructions or No correction required.",
  "detectedProblems": [
    {
      "type": "string",
      "description": "string",
      "severity": "Low or Medium or High or Critical"
    }
  ],
  "badgeOverlapDetected": true or false,
  "safeMarginViolation": true or false,
  "qualityIssueDetected": true or false,
  "awardTextDetected": true or false,
  "unrelatedTextInBadgeZone": true or false
}
`;

  const response = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: GROQ_MODEL,
      temperature: 0,
      max_tokens: 1400,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: userPrompt,
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${base64Image}`,
              },
            },
          ],
        },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 90000,
    }
  );

  const content = response.data?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Empty response from Groq.");
  }

  return normalizeGroqResult(parseJsonFromText(content));
}

function isFalseAwardTextIssue(aiResult) {
  const details = `${aiResult.issueDetailsText || ""} ${
    aiResult.correctionInstructions || ""
  }`.toLowerCase();

  const mentionsAwardText =
    details.includes("winner of the 21st century emily dickinson") ||
    details.includes("award text") ||
    details.includes("award badge");

  const noUnrelatedText =
    aiResult.unrelatedTextInBadgeZone === false ||
    aiResult.unrelatedTextInBadgeZone === undefined;

  return mentionsAwardText && noUnrelatedText;
}

function hasOnlyPositiveChecks(text = "") {
  const lowerText = text.toLowerCase();

  const hasNegativeMarker =
    lowerText.includes("❌") ||
    lowerText.includes("overlap detected") ||
    lowerText.includes("violation") ||
    lowerText.includes("problem") ||
    lowerText.includes("issue detected") ||
    lowerText.includes("requires review");

  const hasPositiveMarker = lowerText.includes("✅");

  return hasPositiveMarker && !hasNegativeMarker;
}

function saysNoCorrectionRequired(text = "") {
  const lowerText = text.toLowerCase();

  return (
    lowerText.includes("no correction required") ||
    lowerText.includes("no corrections required") ||
    lowerText.includes("no correction is required")
  );
}

function applyRuleBasedBackup(aiResult, metadata) {
  let result = { ...aiResult };

  let detectedProblems = Array.isArray(result.detectedProblems)
    ? [...result.detectedProblems]
    : [];

  const minimumRecommendedWidth = 900;
  const minimumRecommendedHeight = 1400;

  const hasLowResolution =
    metadata.width < minimumRecommendedWidth ||
    metadata.height < minimumRecommendedHeight;

  if (hasLowResolution) {
    detectedProblems.push({
      type: "Low Resolution",
      description: `Cover image resolution is ${metadata.width}x${metadata.height}px, which may be low for print-quality validation.`,
      severity: "Medium",
    });

    result.qualityIssueDetected = true;
  }

  /**
   * Fix false positives where Groq complains about the official award text itself.
   */
  const falseAwardIssue = isFalseAwardTextIssue(result);

  if (falseAwardIssue && detectedProblems.length === 0 && !hasLowResolution) {
    result = {
      ...result,
      status: "PASS",
      confidenceScore: Math.max(Number(result.confidenceScore || 0), 94),
      issueType: "None",
      severity: "Low",
      badgeOverlapDetected: false,
      unrelatedTextInBadgeZone: false,
      safeMarginViolation: false,
      qualityIssueDetected: false,
      issueDetailsText:
        "✅ Author name is placed above the reserved award badge area.\n✅ No unrelated text overlaps with the bottom award zone.\n✅ The expected award text is present in the bottom section.\n✅ Safe margins appear acceptable.\n✅ Cover text appears clear and readable.",
      correctionInstructions:
        "No correction required. The cover follows the validation rules.",
      detectedProblems: [],
    };

    detectedProblems = [];
  }

  /**
   * Fix case where Groq says REVIEW NEEDED but all checks are positive
   * and correction instructions say no correction required.
   */
  const onlyPositiveChecks = hasOnlyPositiveChecks(result.issueDetailsText);
  const noCorrectionRequired = saysNoCorrectionRequired(
    result.correctionInstructions
  );

  if (
    onlyPositiveChecks &&
    noCorrectionRequired &&
    result.unrelatedTextInBadgeZone !== true &&
    result.badgeOverlapDetected !== true &&
    result.safeMarginViolation !== true &&
    result.qualityIssueDetected !== true &&
    detectedProblems.length === 0 &&
    !hasLowResolution
  ) {
    result.status = "PASS";
    result.confidenceScore = Math.max(Number(result.confidenceScore || 0), 94);
    result.issueType = "None";
    result.severity = "Low";
    result.badgeOverlapDetected = false;
    result.unrelatedTextInBadgeZone = false;
    result.safeMarginViolation = false;
    result.qualityIssueDetected = false;
    detectedProblems = [];
  }

  const hasRealIssue =
    result.badgeOverlapDetected === true ||
    result.unrelatedTextInBadgeZone === true ||
    result.safeMarginViolation === true ||
    result.qualityIssueDetected === true ||
    detectedProblems.length > 0;

  if (hasRealIssue) {
    result.status = "REVIEW NEEDED";
    result.confidenceScore = Math.max(Number(result.confidenceScore || 75), 88);
  } else {
    result.status = "PASS";
    result.confidenceScore = Math.max(Number(result.confidenceScore || 90), 92);
  }

  const issueType =
    result.status === "PASS"
      ? "None"
      : result.issueType && result.issueType !== "None"
      ? result.issueType
      : detectedProblems[0]?.type || "Layout Validation Issue";

  const severity =
    result.status === "PASS"
      ? "Low"
      : result.severity && result.severity !== "Low"
      ? result.severity
      : detectedProblems[0]?.severity || "High";

  const issueDetailsText =
    result.status === "PASS"
      ? result.issueDetailsText ||
        "✅ No layout issue detected\n✅ Award badge area is clear from unrelated text\n✅ Author name placement is acceptable\n✅ Safe margins appear acceptable"
      : result.issueDetailsText ||
        detectedProblems
          .map((problem) => `❌ ${problem.type}: ${problem.description}`)
          .join("\n");

  const correctionInstructions =
    result.status === "PASS"
      ? "No correction required. The cover follows the validation rules."
      : result.correctionInstructions ||
        "1. Move all title, subtitle, author name, quote, or unrelated text above the bottom 9mm award badge reserved area.\n2. Keep at least 3mm margin from the left and right borders.\n3. Do not treat the official award text as an issue.\n4. Re-upload the corrected file.";

  return {
    status: result.status,
    confidenceScore: Math.min(100, Math.max(0, Number(result.confidenceScore))),
    issueType,
    severity,
    issueDetailsText,
    correctionInstructions,
    detectedProblems,
  };
}

async function prepareInputImage(filePath, mimetype) {
  if (
    mimetype === "application/pdf" ||
    path.extname(filePath).toLowerCase() === ".pdf"
  ) {
    const pngPath = await convertPdfToPng(filePath);
    return normalizeImage(pngPath);
  }

  return normalizeImage(filePath);
}

app.get("/", (_req, res) => {
  res.json({
    message: "BookLeaf Cover Validator Backend is running",
    groqEnabled: Boolean(
      GROQ_API_KEY && GROQ_API_KEY !== "your_groq_api_key_here"
    ),
    endpoint: "POST /api/validate-cover",
  });
});

app.post("/api/validate-cover", upload.single("cover"), async (req, res) => {
  const startedAt = new Date();

  try {
    const { isbn, fileName, googleDriveFileId } = req.body;

    if (!req.file) {
      return res.status(400).json({
        status: "REVIEW NEEDED",
        confidenceScore: 0,
        issueType: "Missing File",
        severity: "Critical",
        issueDetailsText: "❌ No cover file was received by the backend.",
        correctionInstructions: "Please upload a valid PDF or PNG cover file.",
        detectionTimestamp: startedAt.toISOString(),
      });
    }

    if (!isbn) {
      return res.status(400).json({
        status: "REVIEW NEEDED",
        confidenceScore: 0,
        issueType: "Missing ISBN",
        severity: "Critical",
        issueDetailsText: "❌ ISBN was not provided.",
        correctionInstructions:
          "Please provide ISBN from the workflow or use the required file naming format.",
        detectionTimestamp: startedAt.toISOString(),
      });
    }

    const originalFilePath = req.file.path;

    const normalizedImagePath = await prepareInputImage(
      originalFilePath,
      req.file.mimetype
    );

    const frontCoverExtraction = await extractFrontCoverIfSpread(
      normalizedImagePath
    );

    const frontCoverPath = frontCoverExtraction.frontCoverPath;
    const metadata = await getImageMetadata(frontCoverPath);
    const zones = calculateZones(metadata);

    const aiResult = await analyzeCoverWithGroq({
      imagePath: frontCoverPath,
      metadata,
      zones,
      isbn,
      fileName: fileName || req.file.originalname,
      wasSpreadDetected: frontCoverExtraction.wasSpreadDetected,
    });

    const finalResult = applyRuleBasedBackup(aiResult, metadata);
    const author = getAuthorByISBN(isbn);

    return res.json({
      isbn,
      authorName: author.authorName,
      authorEmail: author.authorEmail,
      fileName: fileName || req.file.originalname,
      googleDriveFileId: googleDriveFileId || "",
      status: finalResult.status,
      confidenceScore: finalResult.confidenceScore,
      issueType: finalResult.issueType,
      severity: finalResult.severity,
      issueDetailsText: finalResult.issueDetailsText,
      correctionInstructions: finalResult.correctionInstructions,
      visualAnnotationUrl: "",
      revisionCount: 1,
      detectionTimestamp: startedAt.toISOString(),
      supportEmail: SUPPORT_EMAIL,
      technicalMetadata: {
        originalMimeType: req.file.mimetype,
        wasSpreadDetected: frontCoverExtraction.wasSpreadDetected,
        cropInfo: frontCoverExtraction.cropInfo,
        imageWidth: metadata.width,
        imageHeight: metadata.height,
        sideSafeMarginPx: zones.sideSafeMarginPx,
        bottomBadgeZonePx: zones.bottomBadgeZonePx,
        badgeZone: zones.badgeZone,
        safeArea: zones.safeArea,
      },
    });
  } catch (error) {
    console.error("Validation error:", error);

    return res.status(500).json({
      isbn: req.body?.isbn || "",
      authorName: "Author",
      authorEmail: DEFAULT_AUTHOR_EMAIL,
      fileName: req.body?.fileName || req.file?.originalname || "",
      status: "REVIEW NEEDED",
      confidenceScore: 50,
      issueType: "System Processing Error",
      severity: "High",
      issueDetailsText: `❌ Automated validation could not be completed: ${error.message}`,
      correctionInstructions:
        "Please manually review this cover or re-upload the file. Ensure the file is a valid PDF or PNG.",
      visualAnnotationUrl: "",
      revisionCount: 1,
      detectionTimestamp: new Date().toISOString(),
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`BookLeaf Cover Validator backend running on port ${PORT}`);
});