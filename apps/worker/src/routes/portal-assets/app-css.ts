/**
 * Stylesheet for the buyer-facing dealer portal SPA. Served at
 * /proxy/portal/static/app.css. Intentionally minimal — merchants can
 * later override via theme/brand settings once the surface stabilises.
 */
export const APP_CSS = String.raw`:root {
  --b2b-fg: #111;
  --b2b-fg-muted: #555;
  --b2b-bg: #fff;
  --b2b-bg-subtle: #f6f6f7;
  --b2b-border: #e1e3e5;
  --b2b-accent: #1a73e8;
  --b2b-accent-fg: #fff;
  --b2b-error: #b42318;
  --b2b-radius: 6px;
  --b2b-gap: 16px;
}

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  color: var(--b2b-fg);
  background: var(--b2b-bg);
  line-height: 1.45;
}

main#b2b-portal-root {
  max-width: 960px;
  margin: 0 auto;
  padding: 24px 16px 48px;
}

.b2b-tour {
  background: var(--b2b-bg-subtle);
  border: 1px solid var(--b2b-border);
  border-radius: var(--b2b-radius);
  padding: 16px;
  margin-bottom: 24px;
}

.b2b-tour h3 {
  margin: 0 0 8px;
}

.b2b-tour ul {
  margin: 0 0 12px;
  padding-left: 20px;
}

#b2b-tour-dismiss {
  background: var(--b2b-accent);
  color: var(--b2b-accent-fg);
  border: 0;
  border-radius: var(--b2b-radius);
  padding: 8px 16px;
  cursor: pointer;
}

.b2b-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--b2b-border);
  margin-bottom: 24px;
}

.b2b-tabs button {
  background: none;
  border: 0;
  border-bottom: 2px solid transparent;
  padding: 10px 16px;
  font-size: 15px;
  cursor: pointer;
  color: var(--b2b-fg-muted);
}

.b2b-tabs button.active {
  color: var(--b2b-fg);
  border-bottom-color: var(--b2b-accent);
}

.b2b-loading,
.b2b-empty {
  color: var(--b2b-fg-muted);
}

.b2b-error {
  color: var(--b2b-error);
}

.b2b-asset-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: var(--b2b-gap);
}

.b2b-asset {
  border: 1px solid var(--b2b-border);
  border-radius: var(--b2b-radius);
  padding: 16px;
}

.b2b-asset-title {
  font-weight: 600;
  font-size: 16px;
  margin-bottom: 4px;
}

.b2b-asset-meta {
  color: var(--b2b-fg-muted);
  font-size: 13px;
  margin-bottom: 4px;
}

.b2b-asset-desc {
  font-size: 14px;
  margin-bottom: 8px;
}

.b2b-download {
  background: var(--b2b-accent);
  color: var(--b2b-accent-fg);
  border: 0;
  border-radius: var(--b2b-radius);
  padding: 8px 16px;
  cursor: pointer;
  font-size: 14px;
}

.b2b-download:hover,
#b2b-tour-dismiss:hover {
  opacity: 0.9;
}

.b2b-tier,
.b2b-company {
  margin-bottom: 24px;
}

.b2b-tier h2,
.b2b-company h2 {
  font-size: 18px;
  margin: 0 0 8px;
}

.b2b-company h3 {
  font-size: 15px;
  margin: 16px 0 4px;
}

.b2b-company ul {
  margin: 0;
  padding-left: 20px;
}
`;
