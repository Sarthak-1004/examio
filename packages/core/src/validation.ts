import { z } from "zod";
import { MAX_IDENTIFIER_LENGTH, MAX_PASSWORD_LENGTH, normalizePhone } from "./normalize";

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters.")
  .max(MAX_PASSWORD_LENGTH, "Password is too long.");

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(MAX_IDENTIFIER_LENGTH, "Email address is too long.")
  .pipe(z.email("Enter a valid email address."));

export const phoneSchema = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const p = normalizePhone(v);
    if (!p) {
      ctx.addIssue({ code: "custom", message: "Enter a valid mobile number." });
      return z.NEVER;
    }
    return p;
  });

const optionalEmail = z.union([z.literal("").transform(() => null), emailSchema]).nullable().optional();
const optionalPhone = z.union([z.literal("").transform(() => null), phoneSchema]).nullable().optional();

export const createSchoolSchema = z
  .object({
    name: z.string().trim().min(3, "School name is required.").max(200),
    code: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9]{2,12}$/, "Code must be 2–12 lowercase letters or digits (e.g. dps, sxs01)."),
    boardId: z.uuid("Select a board."),
    mediumId: z.uuid("Select a medium."),
    timezone: z.string().trim().min(1).max(64).default("Asia/Kolkata"),
    address: optionalText(500),
    contactEmail: optionalEmail,
    contactPhone: optionalPhone,
    admin: z
      .object({
        fullName: z.string().trim().min(2, "Admin name is required.").max(200),
        email: optionalEmail,
        phone: optionalPhone,
        password: passwordSchema,
      })
      .refine((a) => a.email || a.phone, { message: "Give the admin an email or mobile number.", path: ["email"] }),
  });

export type CreateSchoolInput = z.input<typeof createSchoolSchema>;

export const lookupNameSchema = z.string().trim().min(2, "Name is required.").max(80);
