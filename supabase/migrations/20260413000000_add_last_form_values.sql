-- ═══════════════════════════════════════════════════════════════════
--  Add last_form_values to sites
--  Stores the most recent form inputs submitted for a project so
--  the UI can pre-fill the analyzer form when a project is selected.
--  Safe to run multiple times — uses IF NOT EXISTS.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS last_form_values JSONB;

-- Example shape stored in last_form_values:
-- {
--   "homeUrl":         "https://example.com",
--   "articleUrl":      "https://example.com/article/slug",
--   "sectionUrl":      "https://example.com/section/",
--   "tagUrl":          "https://example.com/tag/news",
--   "searchUrl":       "https://example.com/search?q=test",
--   "authorUrl":       "https://example.com/author/jane",
--   "videoArticleUrl": "https://example.com/video/slug"
-- }
-- Only fields that were non-empty at submission time are included.
