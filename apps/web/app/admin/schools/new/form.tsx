"use client";

import { useActionState, useState } from "react";
import { createSchoolAction } from "@/app/admin/actions";
import { Alert, Button, Card, CardHeader, Field, Input, Select, Textarea } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

type Opt = { id: string; name: string };

function generatePassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export function NewSchoolForm({ boards, mediums }: { boards: Opt[]; mediums: Opt[] }) {
  const [state, action] = useActionState(createSchoolAction, {});
  const [password, setPassword] = useState("");
  const f = state.fields ?? {};
  const v = state.values ?? {};

  return (
    <form action={action} className="space-y-6">
      {state.message && <Alert>{state.message}</Alert>}

      <Card>
        <CardHeader title="School details" />
        <div className="grid gap-5 p-5 sm:grid-cols-2">
          <Field label="School name" htmlFor="name" error={f.name} className="sm:col-span-2">
            <Input id="name" name="name" required defaultValue={v.name} invalid={!!f.name} />
          </Field>
          <Field label="School code" htmlFor="code" error={f.code} hint="2–12 lowercase letters/digits. Prefixes student usernames, e.g. gvps1023.">
            <Input id="code" name="code" required pattern="[a-zA-Z0-9]{2,12}" defaultValue={v.code} invalid={!!f.code} className="font-mono lowercase" />
          </Field>
          <Field label="Time zone" htmlFor="timezone">
            <Select id="timezone" name="timezone" defaultValue={v.timezone ?? "Asia/Kolkata"}>
              <option value="Asia/Kolkata">India (Asia/Kolkata)</option>
              <option value="Asia/Dubai">UAE (Asia/Dubai)</option>
              <option value="Asia/Kathmandu">Nepal (Asia/Kathmandu)</option>
            </Select>
          </Field>
          <Field label="Board" htmlFor="boardId" error={f.boardId}>
            <Select id="boardId" name="boardId" required defaultValue={v.boardId ?? ""} invalid={!!f.boardId}>
              <option value="" disabled>
                Select board…
              </option>
              {boards.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Medium of instruction" htmlFor="mediumId" error={f.mediumId}>
            <Select id="mediumId" name="mediumId" required defaultValue={v.mediumId ?? ""} invalid={!!f.mediumId}>
              <option value="" disabled>
                Select medium…
              </option>
              {mediums.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Address" htmlFor="address" className="sm:col-span-2">
            <Textarea id="address" name="address" rows={2} defaultValue={v.address} />
          </Field>
          <Field label="School contact email" htmlFor="contactEmail" error={f.contactEmail}>
            <Input id="contactEmail" name="contactEmail" type="email" defaultValue={v.contactEmail} invalid={!!f.contactEmail} />
          </Field>
          <Field label="School contact phone" htmlFor="contactPhone" error={f.contactPhone}>
            <Input id="contactPhone" name="contactPhone" type="tel" inputMode="tel" defaultValue={v.contactPhone} invalid={!!f.contactPhone} />
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader title="School Admin / Principal account" description="They will be asked to set their own password at first sign-in." />
        <div className="grid gap-5 p-5 sm:grid-cols-2">
          <Field label="Full name" htmlFor="adminName" error={f.adminName} className="sm:col-span-2">
            <Input id="adminName" name="adminName" required defaultValue={v.adminName} invalid={!!f.adminName} />
          </Field>
          <Field label="Email" htmlFor="adminEmail" error={f.adminEmail} hint="Email or mobile is required.">
            <Input id="adminEmail" name="adminEmail" type="email" defaultValue={v.adminEmail} invalid={!!f.adminEmail} />
          </Field>
          <Field label="Mobile number" htmlFor="adminPhone" error={f.adminPhone}>
            <Input id="adminPhone" name="adminPhone" type="tel" inputMode="tel" defaultValue={v.adminPhone} invalid={!!f.adminPhone} />
          </Field>
          <Field label="Temporary password" htmlFor="adminPassword" error={f.adminPassword} hint="Share this with the admin securely." className="sm:col-span-2">
            <div className="flex gap-2">
              <Input
                id="adminPassword"
                name="adminPassword"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="font-mono"
                autoComplete="off"
                invalid={!!f.adminPassword}
              />
              <Button type="button" variant="secondary" onClick={() => setPassword(generatePassword())}>
                Generate
              </Button>
            </div>
          </Field>
        </div>
      </Card>

      <div className="flex justify-end">
        <SubmitButton pendingText="Creating school…">Create school</SubmitButton>
      </div>
    </form>
  );
}
