-- Días base del motor de descanso por tipo de pasto (JSON). La app fusiona con defaults si es null.
alter table campos add column if not exists descanso_bases_dias jsonb default null;
