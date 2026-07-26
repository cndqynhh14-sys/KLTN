'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const CONTENT_TYPES = Object.freeze({
  HTML: 'text/html; charset=utf-8',
  PDF: 'application/pdf',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
});

const EXTENSIONS = Object.freeze({ HTML: 'html', PDF: 'pdf', XLSX: 'xlsx' });

function artifactError(code, status = 500, message = code) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function checksumBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) throw artifactError('report_artifact_buffer_invalid');
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function checksumText(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function normalizeStorageKey(value) {
  const input = String(value || '');
  if (!input || input.includes('\0') || input.includes('\\') || input.includes(':') || path.isAbsolute(input)) {
    throw artifactError('report_storage_key_invalid', 400);
  }
  const parts = input.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..') || input.includes('..')) {
    throw artifactError('report_storage_key_invalid', 400);
  }
  const normalized = path.posix.normalize(input);
  if (normalized !== input || normalized.startsWith('/')) throw artifactError('report_storage_key_invalid', 400);
  return normalized;
}

function safeFileName(value, format) {
  const extension = EXTENSIONS[String(format || '').toUpperCase()];
  if (!extension) throw artifactError('report_format_not_supported', 400);
  const wellFormed = typeof String(value || '').toWellFormed === 'function'
    ? String(value || '').toWellFormed()
    : String(value || '').replace(/[\uD800-\uDFFF]/g, '_');
  const withoutPath = wellFormed
    .replace(/[\r\n/\\]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    .replace(/[^\p{L}\p{N}._ -]+/gu, '_')
    .trim()
    .slice(0, 160);
  const base = (withoutPath || 'report').replace(new RegExp(`\\.${extension}$`, 'i'), '');
  return `${base}.${extension}`;
}

function contentDisposition(fileName) {
  const finalName = String(fileName || 'report')
    .replace(/[\r\n/\\]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '_');
  const asciiName = finalName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_');
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(finalName)}`;
}

function assertArtifactBytes({ buffer, format, mimeType, sha256 = null, sizeBytes = null }) {
  const finalFormat = String(format || '').toUpperCase();
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw artifactError('report_artifact_empty', 422);
  if (CONTENT_TYPES[finalFormat] !== mimeType) throw artifactError('report_artifact_content_type_invalid', 422);
  if (sizeBytes != null && Number(sizeBytes) !== buffer.length) throw artifactError('report_artifact_size_mismatch', 410);
  const actualHash = checksumBuffer(buffer);
  if (sha256 && actualHash !== sha256) throw artifactError('report_artifact_checksum_mismatch', 410);
  if (finalFormat === 'PDF' && !buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw artifactError('report_artifact_signature_invalid', 422);
  }
  if (finalFormat === 'XLSX' && !buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    throw artifactError('report_artifact_signature_invalid', 422);
  }
  if (finalFormat === 'HTML') {
    const prefix = buffer.subarray(0, Math.min(buffer.length, 256)).toString('utf8').trimStart().toLowerCase();
    if (!prefix.startsWith('<!doctype html') && !prefix.startsWith('<html')) {
      throw artifactError('report_artifact_signature_invalid', 422);
    }
  }
  return { sha256: actualHash, size_bytes: buffer.length, mime_type: mimeType, file_format: finalFormat };
}

function availabilityForReadError(error) {
  if (error?.code === 'report_artifact_missing') return 'MISSING';
  if (new Set([
    'report_artifact_empty',
    'report_artifact_content_type_invalid',
    'report_artifact_size_mismatch',
    'report_artifact_checksum_mismatch',
    'report_artifact_signature_invalid',
  ]).has(error?.code)) return 'QUARANTINED';
  return null;
}

module.exports = {
  CONTENT_TYPES,
  EXTENSIONS,
  artifactError,
  assertArtifactBytes,
  availabilityForReadError,
  checksumBuffer,
  checksumText,
  contentDisposition,
  normalizeStorageKey,
  safeFileName,
};
