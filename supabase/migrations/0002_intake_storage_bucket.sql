-- Intake uploads land in a private Storage bucket. An IntakeSource row's `uri`
-- is "<bucket>/<path>" (e.g. "intake-sources/<pursuit>/transcript.docx"); the
-- edge reader downloads the object and decodes it per format. Pasted text uses
-- a data: URI instead and never touches Storage.
insert into storage.buckets (id, name, public)
values ('intake-sources', 'intake-sources', false)
on conflict (id) do nothing;
