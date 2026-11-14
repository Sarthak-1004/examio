import { selectSchoolAction } from "@/app/actions/auth";
import { requireSession } from "@/lib/auth";

export default async function SelectSchool() {
  const s = await requireSession();
  const schools = [...new Map(s.memberships.map((m) => [m.schoolId, m])).values()];
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-center text-xl font-bold text-slate-900">Choose a school</h1>
        <ul className="mt-6 space-y-2">
          {schools.map((m) => (
            <li key={m.schoolId}>
              <form action={selectSchoolAction}>
                <input type="hidden" name="schoolId" value={m.schoolId} />
                <button className="w-full rounded-xl bg-white px-4 py-3 text-left shadow-sm ring-1 ring-slate-200 hover:ring-brand-500">
                  <span className="font-medium text-slate-900">{m.schoolName}</span>
                </button>
              </form>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
