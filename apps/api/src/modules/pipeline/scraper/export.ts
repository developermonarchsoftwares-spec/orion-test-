/**
 * Local CSV / JSON export. No database. Previous results are preserved: a new run merges into the existing file unless overwrite is
 * requested, and a file with an unexpected layout is never clobbered. Port of business_scraper/export.py.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { FIELDS, ScrapedRecord } from './extract';

const FORMULA_START = ['=', '+', '-', '@', '\t', '\r'];
const E164 = /^\+[0-9]{7,15}$/;

export class ExportError extends Error {}

export function formatFor(path: string, requested = ''): string {
  if (requested) return requested.toLowerCase();
  return path.toLowerCase().endsWith('.json') ? 'json' : 'csv';
}

/** Neutralises spreadsheet formula injection. A validated E.164 phone number starts with '+' but is digits only, so it is left alone. */
export function csvSafe(field: string, value: string): string {
  if (!value || !FORMULA_START.some((c) => value.startsWith(c))) return value;
  if (field === 'phone' && E164.test(value)) return value;
  return "'" + value;
}

/** Undoes csvSafe when re-reading our own file. */
const unsafe = (value: string): string => (value.startsWith("'") && value.length > 1 && '=+-@\t\r'.includes(value[1]) ? value.slice(1) : value);

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}

export function loadExisting(path: string, fmt: string): ScrapedRecord[] {
  if (!existsSync(path) || statSync(path).size === 0) return [];
  let rows: Record<string, unknown>[];
  try {
    const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
    if (fmt === 'json') {
      const data = JSON.parse(text);
      if (!Array.isArray(data) || data.some((d) => !d || typeof d !== 'object' || Array.isArray(d))) throw new Error('not a JSON array of objects');
      rows = data;
    } else {
      const parsed = parseCsvRows(text);
      if (JSON.stringify(parsed[0]) !== JSON.stringify([...FIELDS])) throw new Error('unexpected CSV header');
      rows = parsed.slice(1).map((r) => Object.fromEntries(FIELDS.map((k, i) => [k, r[i] ?? ''])));
    }
  } catch (err) {
    throw new ExportError(`existing output file '${path}' cannot be merged (${(err as Error).message}). Use --overwrite to replace it, or choose another file.`);
  }
  return rows.map((row) => new ScrapedRecord(Object.fromEntries(FIELDS.map((k) => [k, unsafe(String(row[k] ?? ''))]))));
}

export function writeRecords(path: string, records: ScrapedRecord[], fmt: string): void {
  const directory = dirname(resolve(path));
  mkdirSync(directory, { recursive: true });
  const tmp = `${resolve(path)}.${process.pid}.${Date.now()}.tmp`;
  try {
    if (fmt === 'json') {
      writeFileSync(tmp, JSON.stringify(records.map((r) => r.row()), null, 2) + '\n', 'utf8');
    } else {
      const lines = [FIELDS.join(',')];
      for (const r of records) {
        const row = r.row();
        lines.push(FIELDS.map((k) => csvCell(csvSafe(k, row[k]))).join(','));
      }
      writeFileSync(tmp, lines.join('\r\n') + '\r\n', 'utf8');
    }
    renameSync(tmp, path);                              // atomic: an interrupted run never leaves a half-written file
  } catch (err) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw err;
  }
}
