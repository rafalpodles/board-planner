import {
  NOTIFICATION_TYPES,
  NotificationChannels,
  NotificationMatrix,
  NotificationType,
  PersonalChatKind,
} from "@/types";

export interface PrefsSource {
  emailNotifications?: boolean;
  notifications?: {
    defaults?: NotificationMatrix;
    projects?: { project: unknown; matrix: NotificationMatrix }[];
    chat?: { kind?: PersonalChatKind | ""; webhookUrl?: string };
  } | null;
}

const OFF: NotificationChannels = { inApp: false, email: false, chat: false };

export function blankMatrix(): NotificationMatrix {
  return Object.fromEntries(
    NOTIFICATION_TYPES.map((type) => [type, { ...OFF }])
  ) as NotificationMatrix;
}

function legacyMatrix(emailNotifications: boolean): NotificationMatrix {
  return Object.fromEntries(
    NOTIFICATION_TYPES.map((type) => [
      type,
      type === "task_created" ? { ...OFF } : { inApp: true, email: emailNotifications, chat: false },
    ])
  ) as NotificationMatrix;
}

export function defaultMatrix(user: PrefsSource | null | undefined): NotificationMatrix {
  const stored = user?.notifications?.defaults;
  if (stored) return { ...blankMatrix(), ...stored };
  return legacyMatrix(!!user?.emailNotifications);
}

function overrideFor(
  user: PrefsSource | null | undefined,
  projectId: string
): NotificationMatrix | undefined {
  const row = user?.notifications?.projects?.find((p) => String(p.project) === String(projectId));
  return row?.matrix;
}

export function hasOverride(user: PrefsSource | null | undefined, projectId: string): boolean {
  return overrideFor(user, projectId) !== undefined;
}

export function matrixInForce(
  user: PrefsSource | null | undefined,
  projectId: string
): NotificationMatrix {
  const own = overrideFor(user, projectId);
  return own ? { ...blankMatrix(), ...own } : defaultMatrix(user);
}

export function chatConnected(user: PrefsSource | null | undefined): boolean {
  const chat = user?.notifications?.chat;
  return !!chat?.kind && !!chat?.webhookUrl;
}

export function resolveChannels(
  user: PrefsSource | null | undefined,
  projectId: string,
  type: NotificationType
): NotificationChannels {
  const row = matrixInForce(user, projectId)[type] ?? { ...OFF };
  return row.chat && !chatConnected(user) ? { ...row, chat: false } : row;
}

export function wantsMailSomewhere(user: PrefsSource | null | undefined): boolean {
  const grids = [defaultMatrix(user), ...(user?.notifications?.projects ?? []).map((p) => p.matrix)];
  return grids.some((grid) => NOTIFICATION_TYPES.some((type) => grid?.[type]?.email));
}

export function withoutChat(matrix: NotificationMatrix): NotificationMatrix {
  return Object.fromEntries(
    NOTIFICATION_TYPES.map((type) => [type, { ...matrix[type], chat: false }])
  ) as NotificationMatrix;
}

export function wantsChat(matrix: NotificationMatrix): boolean {
  return NOTIFICATION_TYPES.some((type) => matrix[type]?.chat);
}

export function normaliseMatrix(input: unknown): NotificationMatrix {
  const source = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return Object.fromEntries(
    NOTIFICATION_TYPES.map((type) => {
      const row = (source[type] && typeof source[type] === "object" ? source[type] : {}) as Record<
        string,
        unknown
      >;
      return [
        type,
        {
          inApp: row.inApp === true,
          email: row.email === true,
          chat: row.chat === true,
        },
      ];
    })
  ) as NotificationMatrix;
}
