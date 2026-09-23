#!/usr/bin/env node
// Extrae la "ficha" de cada producto (requisitos, certificado, aval, duración, temario, docentes,
// beneficios, cursos del diplomado, fecha, PDF) desde el HTML REAL de ceium.net/products/<handle>.
// Uso:  node prisma/seed-data/extract-details.mjs [--offline]
//   - Por defecto descarga cada página en vivo; con --offline (o si falla la red) usa ../ref/html/products__<handle>.html.
// Salida: prisma/seed-data/product-details.json  (lo consume prisma/seed.ts; se versiona).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REF = path.resolve(here, '../../../ref');
const OUT = path.join(here, 'product-details.json');
const offline = process.argv.includes('--offline');
// Caché local de páginas descargadas (no versionada): var/ref-cache/products__<handle>.html
const CACHE = path.resolve(here, '../../var/ref-cache');

const decode = (s) =>
  s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');

function toLines(html) {
  const m = html.match(/<main[\s\S]*<\/main>/);
  const body = (m ? m[0] : html)
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/g, '');
  const pdfs = [...body.matchAll(/href="([^"]+\.pdf[^"]*)"/g)].map((x) => decode(x[1]));
  const lines = decode(body.replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '\n'))
    .split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return { lines, pdfs };
}

const FIELD_LABELS = [
  { re: /^Requisitos$/, key: 'requirements' },
  { re: /^(Certificado|Diplomado de \d+ cursos)$/, key: 'certificate' },
  { re: /^Avalado por /, key: 'endorsement' },
  { re: /^Dirigido a$/, key: 'audience' },
  { re: /^Tiempo de duración$/, key: 'duration' },
];
const SECTION_END = /^(Contenido del curso|Contenidos Académicos|Beneficios|Cursos de este diplomado|Equipo docente|Temas a tratar)$/;
const RELATED = /^(Cursos relacionados|Talleres y cursos relacionados|Cursos del Diplomado|Conoce más|Ver todos|Obtén tu Certificado)/;

// Une fragmentos partidos por <br> o spans (línea que empieza en minúscula = continuación).
function mergeFragments(arr) {
  const out = [];
  for (const s of arr) {
    if (out.length && (/^[a-záéíóúñ(]/.test(s) || out[out.length - 1] === '-' || out[out.length - 1].endsWith(' de'))) {
      out[out.length - 1] = (out[out.length - 1] === '-' ? '- ' + s : out[out.length - 1] + ' ' + s);
    } else out.push(s);
  }
  return out;
}

function parse(handle, lines, pdfs) {
  const d = { handle };
  const title = lines[0];
  let i = 1;
  const desc = [];
  while (i < lines.length && !/^(🎓|✍|📅|Fecha:|Selecciona las opciones:)/.test(lines[i])) desc.push(lines[i++]);
  d.intro = desc;
  for (; i < lines.length && lines[i] !== 'Selecciona las opciones:'; i++) {
    const s = lines[i];
    if (s.startsWith('🎓')) d.belongsTo = lines[i + 1];
    if (s.startsWith('✍')) d.enrollmentNote = s;
    if (s === 'Fecha:') d.eventDateText = lines[i + 1];
    if (s.startsWith('📅')) {
      const label = s.replace(/^📅\s*/, '');
      if (/^Inscripción hasta:?$/.test(label)) d.enrollmentDeadlineText = lines[i + 1]; // dd/mm/aaaa
      else (d.scheduleLinks ??= []).push(label);
    }
  }
  const cart = lines.indexOf('Agregar al carrito', i);
  i = cart + 2; // salta "$precio"
  // Pares etiqueta → valor
  while (i < lines.length && !SECTION_END.test(lines[i])) {
    const f = FIELD_LABELS.find((x) => x.re.test(lines[i]));
    if (f) {
      const label = lines[i];
      const vals = [];
      i++;
      while (i < lines.length && !SECTION_END.test(lines[i]) && !FIELD_LABELS.some((x) => x.re.test(lines[i]))) vals.push(lines[i++]);
      const value = vals.join(' ');
      if (f.key === 'certificate') { d.certificateTitle = label; d.certificateText = value; }
      else if (f.key === 'endorsement') { d.endorsementTitle = label; d.endorsementText = value; }
      else d[f.key] = value;
    } else i++;
  }
  // Beneficios
  const bi = lines.indexOf('Beneficios', cart);
  if (bi > 0) {
    const b = [];
    for (let j = bi + 1; j < lines.length && !SECTION_END.test(lines[j]); j++) if (lines[j] !== '.') b.push(lines[j]);
    d.benefits = mergeFragments(b);
  }
  // Cursos de este diplomado
  const ci = lines.indexOf('Cursos de este diplomado', cart);
  if (ci > 0) {
    const courses = [];
    for (let j = ci + 1; j < lines.length && !RELATED.test(lines[j]) && !SECTION_END.test(lines[j]); j++) {
      const m = lines[j].match(/^(\d+)\.\s*(.+?):?$/);
      if (m) courses.push({ n: Number(m[1]), title: m[2].trim(), highlights: [] });
      else if (courses.length) courses[courses.length - 1].highlights.push(lines[j]);
    }
    for (const c of courses) c.highlights = mergeFragments(c.highlights).filter((h) => h !== '.');
    d.diplomaCourses = courses;
  }
  // Temario
  const ti = lines.indexOf('Temas a tratar', cart);
  const fi = lines.indexOf('Equipo docente', cart);
  if (ti > 0) {
    const end = fi > ti ? fi : lines.findIndex((s, k) => k > ti && RELATED.test(s));
    const raw = mergeFragments(lines.slice(ti + 1, end));
    const topics = [];
    for (const s of raw) {
      const isTema = /^Tema \d+$/.test(s);
      const isBullet = s.startsWith('- ') || s === '-';
      if (isTema || (!isBullet && !topics.length) || (!isBullet && topics.length && topics[topics.length - 1].items.some((x) => x.bullet))) {
        topics.push({ title: s.replace(/:$/, ''), items: [] });
      } else if (!isTema) {
        topics[topics.length - 1].items.push({ text: s.replace(/^-\s*/, ''), bullet: isBullet });
      }
    }
    d.topics = topics.map((t) => ({ title: t.title, items: t.items.map((x) => x.text).filter(Boolean) }));
  }
  if (fi > 0) {
    const fac = [];
    for (let j = fi + 1; j < lines.length && !RELATED.test(lines[j]); j++) fac.push(lines[j]);
    d.faculty = fac;
  }
  const syllabus = pdfs.find((p) => !/CRONOGRAMA/i.test(p));
  if (syllabus) d.syllabusUrl = syllabus.startsWith('//') ? 'https:' + syllabus : syllabus;
  const schedules = pdfs.filter((p) => /CRONOGRAMA/i.test(p));
  if (schedules.length) d.scheduleUrls = [...new Set(schedules)];
  d.title = title;
  return d;
}

const { products } = JSON.parse(await fs.readFile(path.join(REF, 'products.json'), 'utf8'));
const result = {};
for (const p of products) {
  let html = null;
  let source = 'live';
  const cacheFile = path.join(CACHE, `products__${p.handle}.html`);
  if (!offline) {
    for (let attempt = 0; attempt < 3 && !html; attempt++) {
      try {
        const r = await fetch(`https://ceium.net/products/${p.handle}`, { signal: AbortSignal.timeout(30000) });
        if (r.ok) html = await r.text();
        else await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
      } catch { /* retry / fallback */ }
    }
    if (html) { await fs.mkdir(CACHE, { recursive: true }); await fs.writeFile(cacheFile, html); }
  }
  if (!html) {
    source = 'cache';
    html = await fs.readFile(cacheFile, 'utf8').catch(() => null);
  }
  if (!html) {
    source = 'ref-html';
    html = await fs.readFile(path.join(REF, 'html', `products__${p.handle}.html`), 'utf8').catch(() => null);
  }
  if (!html) { console.warn('SIN HTML', p.handle); continue; }
  const { lines, pdfs } = toLines(html);
  result[p.handle] = { source, ...parse(p.handle, lines, pdfs) };
  console.log('ok', source, p.handle);
}
await fs.writeFile(OUT, JSON.stringify({ extractedAt: new Date().toISOString(), products: result }, null, 2));
console.log('→', OUT, Object.keys(result).length, 'productos');
