// Pure policy layer for the Ingestie Gateway (see ingest_object in
// db/schema.ts and server/routes/ingest.js). No DB access here on purpose —
// every function takes a plain client payload and returns a verdict or a
// normalized record, so it is fully unit-testable without Postgres (see
// ingestPolicy.test.js) and so routes/ingest.js stays the only writer.
//
// The typeward rule this module enforces (the Lumina lesson): an object's
// herkomst determines which entry-point it may use, and each entry-point has
// its own required/allowed/refused fields. A wrong call is a 400 — not a
// silent reinterpretation. Two fields are refused on EVERY entry-point:
//
//   - status: everything entering Foundation is `observation` by definition.
//     Epistemic status is assigned later, exclusively by human validation
//     (Absolute Override, Manifest §5). A client that claims a status is
//     not just wrong, it is structurally untrustworthy — refuse, don't strip.
//   - providerConversationId / contentHash: server-derived identity, never
//     client-aanbiedbaar, so a capture source can never forge dedup keys.
//
// No ruisfilter here either: Foundation registers what reaches it. Filtering
// belongs to the capture-kant (Capture RS) before submission.

const OBJECT_TYPES = ["chat", "capture", "document", "diary"];

// Per-entry-point field contract. required = 400 bij afwezigheid;
// allowed = meegenomen na vormvalidatie; refused = 400 bij aanwezigheid.
const CONTRACTS = {
  // AI-chats (ChatGPT/Claude/Gemini via extension of bulk-import). The only
  // type that may carry `turns` — a conversation, not a document.
  chat: {
    sourceDefault: "chat-import",
    required: ["content"],
    allowed: {
      content: "nonemptyString",
      title: "string",
      sourceProvider: "string",
      url: "string",
      tags: "stringArray",
      turns: "turnArray",
      attachments: "attachmentArray",
      occurredAt: "isoString",
      source: "nonemptyString",
    },
  },
  // Desktop-capture (Capture RS) — single activity observations, never a
  // conversation: no turns, no sourceProvider (de afzender ís de bron).
  capture: {
    sourceDefault: null, // `source` is required: which capture client sent it
    required: ["content", "source"],
    allowed: {
      content: "nonemptyString",
      title: "string",
      url: "string",
      tags: "stringArray",
      attachments: "attachmentArray",
      occurredAt: "isoString",
      source: "nonemptyString",
    },
  },
  // Explicitly shared documents (notes, pdfs, files) — no conversation
  // structure, no provider conversation identity.
  document: {
    sourceDefault: null,
    required: ["content", "source"],
    allowed: {
      content: "nonemptyString",
      title: "string",
      url: "string",
      tags: "stringArray",
      attachments: "attachmentArray",
      occurredAt: "isoString",
      source: "nonemptyString",
    },
  },
  // Diary (audio/video-log) — a transcript is segmenten, dus turns zijn hier
  // toegestaan (geen gespreksrollen, wel getimecodeerde fragmenten).
  diary: {
    sourceDefault: "diary",
    required: ["content"],
    allowed: {
      content: "nonemptyString",
      title: "string",
      url: "string",
      tags: "stringArray",
      turns: "turnArray",
      attachments: "attachmentArray",
      occurredAt: "isoString",
      source: "nonemptyString",
    },
  },
};

// Refused on every entry-point, regardless of contract.
const GLOBALLY_REFUSED = ["status", "providerConversationId", "contentHash", "id", "ingestedAt", "updatedAt", "objectType"];

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function checkShape(value, shape, field, errors) {
  switch (shape) {
    case "nonemptyString":
      if (typeof value !== "string" || value.trim() === "") errors.push(`${field} must be a non-empty string`);
      return value;
    case "string":
      if (typeof value !== "string") errors.push(`${field} must be a string`);
      return value;
    case "stringArray":
      if (!Array.isArray(value) || value.some((t) => typeof t !== "string")) errors.push(`${field} must be an array of strings`);
      return value;
    case "turnArray":
      if (!Array.isArray(value) || value.some((t) => !isPlainObject(t) || typeof t.text !== "string" || (t.role !== undefined && typeof t.role !== "string"))) {
        errors.push(`${field} must be an array of {role?, text} objects`);
      }
      return value;
    case "attachmentArray":
      if (!Array.isArray(value) || value.some((a) => !isPlainObject(a) || typeof a.id !== "string")) {
        errors.push(`${field} must be an array of {id, filename?, mimeType?, size?, url?} objects`);
      }
      return value;
    case "isoString":
      if (typeof value !== "string" || Number.isNaN(Date.parse(value))) errors.push(`${field} must be an ISO 8601 timestamp string`);
      return value;
    default:
      errors.push(`${field}: unknown shape ${shape}`);
      return value;
  }
}

/**
 * Validates and normalizes a client payload for one ingest entry-point.
 * Pure — no DB, no clock, no randomness.
 *
 * @param {"chat"|"capture"|"document"|"diary"} objectType — entry-point, fixed by the route
 * @param {object} input — raw client body
 * @returns {{ ok: true, record: object } | { ok: false, errors: string[] }}
 *   record.objectType/status zijn hier al gezet: status is ALTIJD
 *   "observation", objectType is ALTIJD de entry-point — geen van beide kan
 *   uit `input` komen.
 */
function normalizeIngestRecord(objectType, input) {
  if (!OBJECT_TYPES.includes(objectType)) {
    return { ok: false, errors: [`unknown object type: ${objectType}`] };
  }
  if (!isPlainObject(input)) {
    return { ok: false, errors: ["body must be a JSON object"] };
  }
  const contract = CONTRACTS[objectType];
  const errors = [];

  for (const field of GLOBALLY_REFUSED) {
    if (input[field] !== undefined) {
      errors.push(`field "${field}" is refused on this endpoint — it is server-owned`);
    }
  }

  const record = {
    objectType, // vastgezet door de route — nooit client-aanbiedbaar
    status: "observation", // vast, zie module-header
  };

  for (const field of contract.required) {
    if (input[field] === undefined || input[field] === null) {
      errors.push(`field "${field}" is required`);
    }
  }

  for (const [field, shape] of Object.entries(contract.allowed)) {
    if (input[field] === undefined || input[field] === null) continue;
    record[field] = checkShape(input[field], shape, field, errors);
  }

  // Unknown fields are refused too (typeward: an exact contract, not a lenient
  // subset) — a typo'd field name must fail loudly instead of vanishing.
  const known = new Set([...Object.keys(contract.allowed), ...GLOBALLY_REFUSED]);
  for (const field of Object.keys(input)) {
    if (!known.has(field)) errors.push(`unknown field "${field}"`);
  }

  // Defaults after validation: source may be defaulted per contract, but
  // only when the entry-point has a meaningful default.
  if (record.source === undefined) {
    if (contract.sourceDefault === null) {
      if (errors.length === 0) errors.push("field \"source\" is required");
    } else {
      record.source = contract.sourceDefault;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, record };
}

module.exports = { normalizeIngestRecord, OBJECT_TYPES };
