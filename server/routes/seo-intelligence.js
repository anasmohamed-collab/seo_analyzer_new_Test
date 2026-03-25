/**
 * SEO Intelligence route — backward-compatible endpoint.
 * Delegates to shared technical-checks module.
 */
import { Router } from 'express';
import { analyzeTechnical, generateRecommendations, createErrorResponse } from '../lib/technical-checks.js';

export const seoIntelligenceRouter = Router();

const FETCH_TIMEOUT = 15000;

async function analyzePage(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    let response;
    try {
      response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Technical-SEO-Analyzer/3.0)' },
        redirect: 'follow',
        signal: controller.signal,
      });
    } finally { clearTimeout(timer); }

    if (!response.ok) return createErrorResponse(url, `error: HTTP ${response.status}`);

    const html = await response.text();
    const analysis = await analyzeTechnical(html, url);
    analysis.recommendations = generateRecommendations(analysis);
    return analysis;
  } catch (error) {
    return createErrorResponse(url, `error: ${error.message}`);
  }
}

seoIntelligenceRouter.post('/', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json(createErrorResponse('', 'error: URL is required'));
    const analysis = await analyzePage(url);
    return res.json(analysis);
  } catch (error) {
    console.error('seo-intelligence error:', error);
    return res.status(500).json(createErrorResponse('', `error: ${error.message}`));
  }
});
