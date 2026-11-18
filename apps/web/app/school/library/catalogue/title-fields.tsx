import { Field, Input } from "@/components/ui";

/** Title details, shared by the add and edit forms. */
export function TitleFields({ t }: { t?: { title: string; author: string | null; isbn: string | null; publisher: string | null; category: string | null } }) {
  return (
    <>
      <Field label="Title" htmlFor="title">
        <Input id="title" name="title" required maxLength={200} defaultValue={t?.title} />
      </Field>
      <Field label="Author (optional)" htmlFor="author">
        <Input id="author" name="author" maxLength={200} defaultValue={t?.author ?? ""} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="ISBN (optional)" htmlFor="isbn">
          <Input id="isbn" name="isbn" maxLength={17} defaultValue={t?.isbn ?? ""} />
        </Field>
        <Field label="Category (optional)" htmlFor="category">
          <Input id="category" name="category" maxLength={80} defaultValue={t?.category ?? ""} />
        </Field>
      </div>
      <Field label="Publisher (optional)" htmlFor="publisher">
        <Input id="publisher" name="publisher" maxLength={200} defaultValue={t?.publisher ?? ""} />
      </Field>
    </>
  );
}
