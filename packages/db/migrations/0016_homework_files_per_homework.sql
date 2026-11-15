DROP INDEX "homework_files_file_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "homework_files_homework_file_unique" ON "homework_files" USING btree ("homework_id","file_id");