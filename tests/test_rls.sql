-- Run after mock_supabase_auth.sql + schema.sql. Any failed assertion raises.
\set ON_ERROR_STOP on
insert into public.allowlist(email, role) values ('pi@lab.org','admin'), ('stu@lab.org','member');
insert into auth.users(id,email,raw_user_meta_data) values
 ('00000000-0000-0000-0000-00000000000a','PI@lab.org','{"full_name":"The PI"}'),
 ('00000000-0000-0000-0000-00000000000b','stu@lab.org','{"name":"Student"}'),
 ('00000000-0000-0000-0000-00000000000c','random@gmail.com','{}');

do $$ begin
  assert (select role from profiles where email='pi@lab.org')='admin', 'pi admin';
  assert (select role from profiles where email='random@gmail.com')='pending', 'stranger pending';
end $$;

-- ---- outsider (pending) sees nothing, cannot write
set role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-00000000000c","role":"authenticated"}',false);
do $$ begin
  assert (select count(*) from profiles)=1, 'pending sees only own profile';
  begin insert into papers(title) values ('x'); assert false, 'pending insert should fail';
  exception when insufficient_privilege then null; end;
  begin update profiles set role='admin' where id=auth.uid(); assert false, 'self-escalation should fail';
  exception when raise_exception then null; end;
end $$;

-- ---- member
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}',false);
insert into papers(title, doi, tags) values ('Paper A','10.1/abc','{tp53,crispr}');
insert into projects(title, hypothesis) values ('Idea 1','H0');
update projects set hypothesis='H1', last_change_note='refined' where title='Idea 1';
update projects set last_change_note='noop' where title='Idea 1';   -- no content change
insert into project_papers(project_id,paper_id,relation)
  select p.id, x.id, 'supports' from projects p, papers x;
insert into paper_notes(paper_id, body, rating) select id,'nice',4 from papers;
insert into project_updates(project_id, body) select id,'pilot worked' from projects;
do $$ begin
  assert (select version from projects where title='Idea 1')=2, 'version bumped once';
  assert (select count(*) from project_versions)=2, 'two snapshots';
  assert (select change_note from project_versions where version=2)='refined', 'note kept';
  assert (select snapshot->>'hypothesis' from project_versions where version=1)='H0', 'v1 snapshot';
  assert (select count(*) from profiles)=3, 'member sees all profiles';
  assert (select count(*) from allowlist)=0, 'member cannot read allowlist';
  begin insert into project_versions(project_id,version,snapshot) select id,99,'{}' from projects;
    assert false, 'direct version insert blocked';
  exception when insufficient_privilege then null; end;
  assert (select n_papers from tag_counts where tag='tp53')=1, 'tag counts';
end $$;

-- ---- admin: notes of others are read-only; allowlist manageable
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}',false);
update paper_notes set body='hacked';
do $$ begin
  assert (select body from paper_notes limit 1)='nice', 'cannot edit others notes';
end $$;
insert into allowlist(email,role) values ('random@gmail.com','member');
do $$ begin
  assert (select role from profiles where email='random@gmail.com')='member', 'allowlist promotes existing user';
end $$;
delete from allowlist where email='random@gmail.com';
do $$ begin
  assert (select role from profiles where email='random@gmail.com')='pending', 'removal demotes';
end $$;

-- ---- anon sees nothing
reset role; set role anon;
do $$ begin
  begin perform 1 from papers; assert false, 'anon read should fail';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
\echo ALL RLS TESTS PASSED
