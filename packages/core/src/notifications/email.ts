import { randomUUID } from "node:crypto";

/**
 * Email provider adapters. Only the sandbox exists today: it records that a message would have
 * been sent and never contacts anyone. A real provider is added when one is chosen; until then
 * EMAIL_PROVIDER accepts only "sandbox", so no environment can send real email by accident.
 */
export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
}

export interface EmailAdapter {
  readonly name: string;
  /** True when messages are recorded instead of sent. */
  readonly sandbox: boolean;
  send(message: OutgoingEmail): Promise<{ providerRef: string }>;
}

export function sandboxEmailAdapter(record?: (message: OutgoingEmail) => void): EmailAdapter {
  return {
    name: "sandbox",
    sandbox: true,
    async send(message) {
      record?.(message);
      return { providerRef: `sandbox-${randomUUID()}` };
    },
  };
}

export const EMAIL_PROVIDERS = ["sandbox"] as const;

export function emailAdapterFromEnv(value: string | undefined): EmailAdapter {
  const provider = (value ?? "sandbox").trim() || "sandbox";
  if (provider === "sandbox") return sandboxEmailAdapter();
  throw new Error(`EMAIL_PROVIDER "${provider}" is not supported. Supported: ${EMAIL_PROVIDERS.join(", ")}.`);
}
