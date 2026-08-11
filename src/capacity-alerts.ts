export const WEEKLY_ALERT_THRESHOLDS = [30, 15, 10, 5, 0] as const;

export type WeeklyAlertThreshold = typeof WEEKLY_ALERT_THRESHOLDS[number];

/** Returns one alert even when a large usage jump crosses several thresholds. */
export function crossedWeeklyThreshold(previousLeft: number, currentLeft: number): WeeklyAlertThreshold | undefined {
  const crossed = WEEKLY_ALERT_THRESHOLDS.filter(
    (threshold) => previousLeft > threshold && currentLeft <= threshold,
  );
  return crossed.length ? Math.min(...crossed) as WeeklyAlertThreshold : undefined;
}
