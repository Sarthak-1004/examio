import { requireSchoolRole } from "@/lib/auth";
import { SetupNav } from "./setup-nav";

/** School setup is for the school's administrators; every action checks this again. */
export default async function SetupLayout({ children }: { children: React.ReactNode }) {
  await requireSchoolRole("school_admin");
  return (
    <>
      <SetupNav />
      {children}
    </>
  );
}
