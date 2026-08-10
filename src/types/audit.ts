export interface Recommendation {
  priority: string;
  area: string;
  message: string;
  fixHint: string;
}

export interface AuditResultRow {
  id: string;
  url: string;
  status: string | null;
  data: Record<string, unknown> | null;
  recommendations: Recommendation[] | null;
}

export interface AuditRunData {
  id: string;
  status: string;
  siteChecks: Record<string, unknown> | null;
  siteRecommendations: Recommendation[];
  resultsByType: Record<string, AuditResultRow[]>;
  results: AuditResultRow[];
}
