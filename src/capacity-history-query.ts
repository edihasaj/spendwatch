/**
 * Downsample after counting raw samples, then join only each bucket's latest
 * timestamp. The final rank resolves same-time source ties deterministically.
 */
export function capacityHistoryQueries(nowMs: number): { history: string; credits: string } {
  const bucket = `CASE
    WHEN sampled_at_ms >= ${Math.round(nowMs - 2 * 86400_000)} THEN 300000
    WHEN sampled_at_ms >= ${Math.round(nowMs - 30 * 86400_000)} THEN 1800000
    WHEN sampled_at_ms >= ${Math.round(nowMs - 180 * 86400_000)} THEN 21600000
    ELSE 86400000 END`;
  return {
    history: `
      WITH buckets AS MATERIALIZED (
        SELECT provider, account,
               CASE WHEN provider = 'codex' AND source = 'codex-session-log' AND account LIKE '%@%' THEN 1 ELSE 0 END AS unverified,
               window_kind AS kind, CAST(sampled_at_ms / (${bucket}) AS INTEGER) AS bucket,
               MAX(sampled_at_ms) AS latestAt, COUNT(*) AS bucketCount
        FROM capacity_history
        GROUP BY provider, account,
          CASE WHEN provider = 'codex' AND source = 'codex-session-log' AND account LIKE '%@%' THEN 1 ELSE 0 END,
          window_kind, CAST(sampled_at_ms / (${bucket}) AS INTEGER)
      ), series_counts AS MATERIALIZED (
        SELECT provider,
               CASE WHEN unverified = 1 THEN 'Unverified historical · ' || account ELSE account END AS account,
               kind, SUM(bucketCount) AS sampleCount
        FROM buckets
        GROUP BY provider, CASE WHEN unverified = 1 THEN 'Unverified historical · ' || account ELSE account END, kind
      ), ranked AS (
        SELECT b.provider,
               CASE WHEN b.unverified = 1 THEN 'Unverified historical · ' || b.account ELSE b.account END AS account,
               b.kind, h.sampled_at_ms AS sampledAt, h.used_percent AS value, h.resets_at_ms AS resetsAt,
               c.sampleCount,
               ROW_NUMBER() OVER (
                PARTITION BY b.provider, CASE WHEN b.unverified = 1 THEN 'Unverified historical · ' || b.account ELSE b.account END, b.kind, b.bucket
                ORDER BY h.sampled_at_ms DESC, h.used_percent DESC, CASE WHEN h.resets_at_ms IS NULL THEN 1 ELSE 0 END,
                   h.resets_at_ms DESC, h.source ASC, h.sample_key ASC
               ) AS rank
        FROM buckets b
        JOIN series_counts c ON c.provider = b.provider
          AND c.account = CASE WHEN b.unverified = 1 THEN 'Unverified historical · ' || b.account ELSE b.account END
          AND c.kind = b.kind
        JOIN capacity_history h ON h.provider = b.provider AND h.account = b.account
          AND h.window_kind = b.kind AND h.sampled_at_ms = b.latestAt
          AND (CASE WHEN h.provider = 'codex' AND h.source = 'codex-session-log' AND h.account LIKE '%@%' THEN 1 ELSE 0 END) = b.unverified
      )
      SELECT provider, account, kind, sampledAt, value, resetsAt, sampleCount
      FROM ranked WHERE rank = 1
      ORDER BY provider, account, kind, sampledAt
    `,
    credits: `
      WITH buckets AS MATERIALIZED (
        SELECT provider, account, CAST(sampled_at_ms / (${bucket}) AS INTEGER) AS bucket,
               MAX(sampled_at_ms) AS latestAt, COUNT(*) AS bucketCount
        FROM capacity_account_history
        WHERE copilot_premium_credits_used IS NOT NULL
        GROUP BY provider, account, CAST(sampled_at_ms / (${bucket}) AS INTEGER)
      ), series_counts AS MATERIALIZED (
        SELECT provider, account, SUM(bucketCount) AS sampleCount
        FROM buckets GROUP BY provider, account
      ), ranked AS (
        SELECT b.provider, b.account, h.sampled_at_ms AS sampledAt,
               h.copilot_premium_credits_used AS value, c.sampleCount,
               ROW_NUMBER() OVER (
                 PARTITION BY b.provider, b.account, b.bucket
                 ORDER BY h.copilot_premium_credits_used DESC, h.sample_key ASC
               ) AS rank
        FROM buckets b
        JOIN series_counts c ON c.provider = b.provider AND c.account = b.account
        JOIN capacity_account_history h ON h.provider = b.provider AND h.account = b.account
          AND h.sampled_at_ms = b.latestAt AND h.copilot_premium_credits_used IS NOT NULL
      )
      SELECT provider, account, sampledAt, value, sampleCount
      FROM ranked WHERE rank = 1
      ORDER BY provider, account, sampledAt
    `,
  };
}
