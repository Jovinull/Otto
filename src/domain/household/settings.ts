import { z } from 'zod';

export const Tone = z.enum(['neutral', 'friendly', 'firm']);
export type Tone = z.infer<typeof Tone>;

const NotificationSettings = z.object({
  enabled: z.boolean().default(true),
  billReminders: z.boolean().default(true),
  budgetAlerts: z.boolean().default(true),
  weeklySummary: z.boolean().default(true),
  monthlyClosing: z.boolean().default(true),
  goalFollowUp: z.boolean().default(true),
});

export const HouseholdSettings = z.object({
  tone: Tone.default('friendly'),
  // 100 significa "atingiu o limite"; OVER_LIMIT_THRESHOLD significa "ultrapassou".
  budgetAlertThresholds: z.array(z.number().int().min(1).max(100)).default([80, 100]),
  billReminderDaysAhead: z.number().int().min(0).max(15).default(3),
  notifications: NotificationSettings.prefault({}),
});
export type HouseholdSettings = z.infer<typeof HouseholdSettings>;

export const MemberPreferences = z.object({
  defaultAccountId: z.string().optional(),
});
export type MemberPreferences = z.infer<typeof MemberPreferences>;

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function parseHouseholdSettings(raw: string): HouseholdSettings {
  const parsed = HouseholdSettings.safeParse(parseJson(raw));
  return parsed.success ? parsed.data : HouseholdSettings.parse({});
}

export function parseMemberPreferences(raw: string): MemberPreferences {
  const parsed = MemberPreferences.safeParse(parseJson(raw));
  return parsed.success ? parsed.data : {};
}
