import { logoutAction } from "@/app/actions/auth";
import { Button } from "@/components/ui";
import { requireSession } from "@/lib/auth";

export default async function NoAccess() {
  const s = await requireSession();
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="max-w-sm text-center">
        <h1 className="text-xl font-bold text-slate-900">No school access</h1>
        <p className="mt-2 text-sm text-slate-600">
          {s.user.fullName}, your account isn&apos;t linked to an active school. Your school may be suspended, or your
          access was removed. Please contact your school office.
        </p>
        <form action={logoutAction} className="mt-6">
          <Button variant="secondary">Sign out</Button>
        </form>
      </div>
    </div>
  );
}
