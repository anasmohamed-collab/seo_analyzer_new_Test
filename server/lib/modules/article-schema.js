/**
 * Module 2 — Article Schema Analyzer
 *
 * Detects and validates JSON-LD structured data for news articles:
 *   - @type = NewsArticle or Article
 *   - Required fields: headline, datePublished, dateModified, author, image
 *   - Multiple conflicting schemas detection
 *   - Field-level validation with recommended fix snippets
 */

const REQUIRED_FIELDS = ['headline', 'datePublished', 'author', 'image'];
const RECOMMENDED_FIELDS = ['dateModified', 'mainEntityOfPage', 'publisher', 'description'];
const ARTICLE_TYPES = ['Article', 'NewsArticle', 'BlogPosting', 'ReportageNewsArticle', 'TechArticle'];

function extractJsonLd(html) {
  const schemas = [];
  const regex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1]);
      // Handle @graph arrays
      if (parsed['@graph'] && Array.isArray(parsed['@graph'])) {
        schemas.push(...parsed['@graph']);
      } else if (Array.isArray(parsed)) {
        schemas.push(...parsed);
      } else {
        schemas.push(parsed);
      }
    } catch {
      schemas.push({ _parseError: true, _raw: m[1].substring(0, 200) });
    }
  }
  return schemas;
}

function isArticleType(type) {
  if (!type) return false;
  if (Array.isArray(type)) return type.some(t => ARTICLE_TYPES.includes(t));
  return ARTICLE_TYPES.includes(type);
}

function validateDateField(value, fieldName) {
  if (!value) return { valid: false, message: `${fieldName} is missing` };
  const d = new Date(value);
  if (isNaN(d.getTime())) return { valid: false, message: `${fieldName} is not a valid ISO date: "${value}"` };
  if (d.getTime() > Date.now() + 86400000) return { valid: false, message: `${fieldName} is in the future` };
  return { valid: true };
}

function validateAuthor(author) {
  if (!author) return { valid: false, message: 'author is missing' };
  if (typeof author === 'string') return { valid: true };
  if (Array.isArray(author)) {
    if (author.length === 0) return { valid: false, message: 'author array is empty' };
    return { valid: true };
  }
  if (typeof author === 'object') {
    if (!author.name && !author['@id']) return { valid: false, message: 'author object missing name' };
    return { valid: true };
  }
  return { valid: false, message: 'author has unexpected format' };
}

function validateImage(image) {
  if (!image) return { valid: false, message: 'image is missing' };
  if (typeof image === 'string') return { valid: true };
  if (Array.isArray(image) && image.length > 0) return { valid: true };
  if (typeof image === 'object' && (image.url || image['@id'])) return { valid: true };
  return { valid: false, message: 'image has unexpected format or no url' };
}

function generateFixSnippet(schema, missingFields) {
  const fix = { '@context': 'https://schema.org', '@type': 'NewsArticle' };

  if (missingFields.includes('headline')) fix.headline = 'Your Article Title Here';
  if (missingFields.includes('datePublished')) fix.datePublished = new Date().toISOString();
  if (missingFields.includes('dateModified')) fix.dateModified = new Date().toISOString();
  if (missingFields.includes('author')) fix.author = { '@type': 'Person', name: 'Author Name' };
  if (missingFields.includes('image')) fix.image = { '@type': 'ImageObject', url: 'https://example.com/image.jpg' };
  if (missingFields.includes('mainEntityOfPage')) fix.mainEntityOfPage = { '@type': 'WebPage', '@id': 'https://example.com/article' };
  if (missingFields.includes('publisher')) fix.publisher = { '@type': 'Organization', name: 'Publisher Name', logo: { '@type': 'ImageObject', url: 'https://example.com/logo.png' } };

  // Merge existing valid fields
  for (const [key, value] of Object.entries(schema)) {
    if (!key.startsWith('_') && !fix[key]) fix[key] = value;
  }

  return fix;
}

export function analyzeArticleSchema(html, pageUrl) {
  const result = {
    module: 'article_schema',
    priority: 'critical',
    status: 'PASS',
    schemas_found: 0,
    article_schemas: [],
    score: 0,
    issues: [],
    fix_snippets: [],
  };

  const allSchemas = extractJsonLd(html);
  result.schemas_found = allSchemas.length;

  if (allSchemas.length === 0) {
    result.status = 'FAIL';
    result.issues.push({
      level: 'critical',
      message: 'No JSON-LD structured data found',
    });
    result.fix_snippets.push(generateFixSnippet({}, REQUIRED_FIELDS.concat(RECOMMENDED_FIELDS)));
    return result;
  }

  // Check for parse errors
  const parseErrors = allSchemas.filter(s => s._parseError);
  if (parseErrors.length > 0) {
    result.issues.push({
      level: 'high',
      message: `${parseErrors.length} JSON-LD block(s) have parse errors`,
    });
  }

  // Filter article schemas
  const articleSchemas = allSchemas.filter(s => isArticleType(s['@type']));

  if (articleSchemas.length === 0) {
    result.status = 'WARNING';
    result.issues.push({
      level: 'high',
      message: `Found ${allSchemas.length} schema(s) but none is Article/NewsArticle type. Types found: ${allSchemas.map(s => s['@type'] || 'unknown').join(', ')}`,
    });
    result.fix_snippets.push(generateFixSnippet({}, REQUIRED_FIELDS.concat(RECOMMENDED_FIELDS)));
    return result;
  }

  // Detect conflicting article schemas
  if (articleSchemas.length > 1) {
    result.issues.push({
      level: 'medium',
      message: `Multiple article schemas found (${articleSchemas.length}). This may confuse search engines.`,
    });
  }

  // Validate each article schema
  let totalScore = 0;
  const maxScore = (REQUIRED_FIELDS.length + RECOMMENDED_FIELDS.length) * 10;

  for (let i = 0; i < articleSchemas.length; i++) {
    const schema = articleSchemas[i];
    const validation = {
      type: schema['@type'],
      index: i,
      fields: {},
      missing_required: [],
      missing_recommended: [],
      score: 0,
    };

    let schemaScore = 0;

    // headline
    if (schema.headline) {
      validation.fields.headline = { status: 'PASS', value: schema.headline.substring(0, 110) };
      schemaScore += 10;
      if (schema.headline.length > 110) {
        validation.fields.headline.status = 'WARNING';
        validation.fields.headline.note = 'Headline exceeds 110 characters (Google recommendation)';
        result.issues.push({ level: 'low', message: `Schema ${i}: headline too long (${schema.headline.length} chars)` });
      }
    } else {
      validation.fields.headline = { status: 'FAIL' };
      validation.missing_required.push('headline');
    }

    // datePublished
    const pubDate = validateDateField(schema.datePublished, 'datePublished');
    if (pubDate.valid) {
      validation.fields.datePublished = { status: 'PASS', value: schema.datePublished };
      schemaScore += 10;
    } else {
      validation.fields.datePublished = { status: 'FAIL', note: pubDate.message };
      validation.missing_required.push('datePublished');
    }

    // dateModified
    const modDate = validateDateField(schema.dateModified, 'dateModified');
    if (modDate.valid) {
      validation.fields.dateModified = { status: 'PASS', value: schema.dateModified };
      schemaScore += 10;
    } else {
      validation.fields.dateModified = { status: 'WARNING', note: modDate.message };
      validation.missing_recommended.push('dateModified');
    }

    // author
    const authorCheck = validateAuthor(schema.author);
    if (authorCheck.valid) {
      validation.fields.author = { status: 'PASS' };
      schemaScore += 10;
    } else {
      validation.fields.author = { status: 'FAIL', note: authorCheck.message };
      validation.missing_required.push('author');
    }

    // image
    const imageCheck = validateImage(schema.image);
    if (imageCheck.valid) {
      validation.fields.image = { status: 'PASS' };
      schemaScore += 10;
    } else {
      validation.fields.image = { status: 'FAIL', note: imageCheck.message };
      validation.missing_required.push('image');
    }

    // mainEntityOfPage
    if (schema.mainEntityOfPage) {
      validation.fields.mainEntityOfPage = { status: 'PASS' };
      schemaScore += 10;
    } else {
      validation.fields.mainEntityOfPage = { status: 'WARNING' };
      validation.missing_recommended.push('mainEntityOfPage');
    }

    // publisher
    if (schema.publisher && (schema.publisher.name || schema.publisher['@id'])) {
      validation.fields.publisher = { status: 'PASS' };
      schemaScore += 10;
    } else {
      validation.fields.publisher = { status: 'WARNING' };
      validation.missing_recommended.push('publisher');
    }

    validation.score = Math.round((schemaScore / maxScore) * 100);
    totalScore += validation.score;

    // Generate issues for missing required fields
    for (const field of validation.missing_required) {
      result.issues.push({
        level: 'critical',
        message: `Schema ${i}: missing required field "${field}"`,
      });
    }

    result.article_schemas.push(validation);

    // Generate fix snippet if anything missing
    const allMissing = [...validation.missing_required, ...validation.missing_recommended];
    if (allMissing.length > 0) {
      result.fix_snippets.push(generateFixSnippet(schema, allMissing));
    }
  }

  result.score = articleSchemas.length > 0 ? Math.round(totalScore / articleSchemas.length) : 0;

  // Determine overall status
  const hasCritical = result.issues.some(i => i.level === 'critical');
  const hasHigh = result.issues.some(i => i.level === 'high');

  if (hasCritical) result.status = 'FAIL';
  else if (hasHigh || result.score < 60) result.status = 'WARNING';
  else result.status = 'PASS';

  return result;
}
