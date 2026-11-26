-- Platform pricing: price/hr = base[gpu] × priority × reliability; host payout = price × host_share.
-- A host is only shown for a job when payout/hr ≥ power_kW × $/kWh × floor_margin.
-- Every value below is editable in the Supabase dashboard without redeploying.

create table public.gpu_rates (
    gpu_model text primary key check (gpu_model ~ '^[a-z0-9-]{1,40}$'),
    label text not null check (length(trim(label)) between 1 and 100),
    vram_gb int not null check (vram_gb > 0),
    -- GPU board power under load; system overhead is added from grove_settings.
    power_kw numeric(5,3) not null check (power_kw > 0),
    base_rate_usd_hr numeric(8,4) not null check (base_rate_usd_hr > 0),
    active boolean not null default true,
    updated_at timestamptz not null default now()
);

create table public.priority_levels (
    id text primary key check (id ~ '^[a-z_]{1,32}$'),
    label text not null,
    multiplier numeric(4,2) not null check (multiplier > 0),
    description text not null default '',
    sort_order int not null default 0
);

create table public.grove_settings (
    id boolean primary key default true check (id),
    host_share numeric(4,3) not null default 0.800 check (host_share > 0 and host_share < 1),
    floor_margin numeric(4,2) not null default 1.50 check (floor_margin >= 1),
    reserve_multiplier numeric(4,2) not null default 1.25 check (reserve_multiplier >= 1),
    system_overhead_kw numeric(5,3) not null default 0.100 check (system_overhead_kw >= 0),
    no_show_minutes int not null default 30 check (no_show_minutes > 0),
    min_topup_usd numeric(8,2) not null default 10 check (min_topup_usd > 0),
    min_withdrawal_usd numeric(8,2) not null default 5 check (min_withdrawal_usd > 0)
);

create table public.electricity_rates (
    state char(2) primary key,
    usd_per_kwh numeric(6,4) not null check (usd_per_kwh > 0)
);

-- USPS ZIP3 prefix ranges by state. Approximate at a few border prefixes; hosts can override $/kWh.
create table public.zip3_ranges (
    zip3_start char(3) primary key check (zip3_start ~ '^[0-9]{3}$'),
    zip3_end char(3) not null check (zip3_end ~ '^[0-9]{3}$' and zip3_end >= zip3_start),
    state char(2) not null
);

do $$
declare t text;
begin
    foreach t in array array['gpu_rates','priority_levels','grove_settings','electricity_rates','zip3_ranges'] loop
        execute format('alter table public.%I enable row level security', t);
        execute format('revoke all on public.%I from public, anon, authenticated', t);
        execute format('grant select on public.%I to anon, authenticated', t);
        execute format('create policy read_%s on public.%I for select to anon, authenticated using (true)', t, t);
    end loop;
end $$;

-- Base rates anchor to Salad's Medium-priority price per GPU-hour (salad.com/pricing, read
-- 2026-11-26; Salad includes vCPU/RAM in the GPU price). The RTX 3060, 3060 Ti, 3070 and 4060 are
-- not on Salad's public table: their rates are Grove estimates, set to clear the power floor at
-- Standard priority. Third-party trackers list them from $0.03-0.12/hr; revisit when Salad publishes.
insert into public.gpu_rates (gpu_model, label, vram_gb, power_kw, base_rate_usd_hr) values
    ('rtx-3060',    'NVIDIA RTX 3060',    12, 0.170, 0.0800),  -- estimate
    ('rtx-3060-ti', 'NVIDIA RTX 3060 Ti',  8, 0.200, 0.0900),  -- estimate
    ('rtx-3070',    'NVIDIA RTX 3070',     8, 0.220, 0.1000),  -- estimate
    ('rtx-3080',    'NVIDIA RTX 3080',    10, 0.320, 0.1230),
    ('rtx-3090',    'NVIDIA RTX 3090',    24, 0.350, 0.1630),
    ('rtx-4060',    'NVIDIA RTX 4060',     8, 0.115, 0.0800),  -- estimate
    ('rtx-4060-ti', 'NVIDIA RTX 4060 Ti',  8, 0.160, 0.1200),
    ('rtx-4070',    'NVIDIA RTX 4070',    12, 0.200, 0.1330),
    ('rtx-4080',    'NVIDIA RTX 4080',    16, 0.320, 0.2170),
    ('rtx-4090',    'NVIDIA RTX 4090',    24, 0.450, 0.3470);

insert into public.priority_levels (id, label, multiplier, description, sort_order) values
    ('batch',    'Batch',    1.00, 'Cheapest. May start later when a host is free.', 1),
    ('standard', 'Standard', 1.30, 'Runs now on an available host.', 2);

insert into public.grove_settings default values;

-- Average residential price by state, EIA Electric Power Monthly Table 5.6.A, September 2026
-- (preliminary; released 2026-11-24). 'US' is the national average and the fallback.
insert into public.electricity_rates (state, usd_per_kwh) values
    ('US',0.1817),('AK',0.2800),('AL',0.1664),('AR',0.1454),('AZ',0.1492),('CA',0.3086),('CO',0.1788),
    ('CT',0.2709),('DC',0.2582),('DE',0.1889),('FL',0.1474),('GA',0.1627),('HI',0.4831),('IA',0.1499),
    ('ID',0.1439),('IL',0.1914),('IN',0.1705),('KS',0.1583),('KY',0.1354),('LA',0.1333),('MA',0.3097),
    ('MD',0.2154),('ME',0.3129),('MI',0.2317),('MN',0.1737),('MO',0.1601),('MS',0.1447),('MT',0.1569),
    ('NC',0.1541),('ND',0.1429),('NE',0.1387),('NH',0.2917),('NJ',0.2464),('NM',0.1696),('NV',0.1325),
    ('NY',0.2842),('OH',0.1909),('OK',0.1522),('OR',0.1573),('PA',0.2220),('RI',0.2993),('SC',0.1650),
    ('SD',0.1631),('TN',0.1329),('TX',0.1591),('UT',0.1341),('VA',0.1774),('VT',0.2483),('WA',0.1500),
    ('WI',0.1942),('WV',0.1623),('WY',0.1496);

insert into public.zip3_ranges (zip3_start, zip3_end, state) values
    ('005','005','NY'),('006','009','PR'),('010','027','MA'),('028','029','RI'),('030','038','NH'),
    ('039','049','ME'),('050','054','VT'),('055','055','MA'),('056','059','VT'),('060','069','CT'),
    ('070','089','NJ'),('100','149','NY'),('150','196','PA'),('197','199','DE'),('200','200','DC'),
    ('201','201','VA'),('202','205','DC'),('206','219','MD'),('220','246','VA'),('247','268','WV'),
    ('270','289','NC'),('290','299','SC'),('300','319','GA'),('320','339','FL'),('341','342','FL'),
    ('344','349','FL'),('350','369','AL'),('370','385','TN'),('386','397','MS'),('398','399','GA'),
    ('400','427','KY'),('430','459','OH'),('460','479','IN'),('480','499','MI'),('500','528','IA'),
    ('530','549','WI'),('550','567','MN'),('570','577','SD'),('580','588','ND'),('590','599','MT'),
    ('600','629','IL'),('630','658','MO'),('660','679','KS'),('680','693','NE'),('700','714','LA'),
    ('716','729','AR'),('730','749','OK'),('750','799','TX'),('800','816','CO'),('820','831','WY'),
    ('832','838','ID'),('840','847','UT'),('850','865','AZ'),('870','884','NM'),('885','885','TX'),
    ('889','898','NV'),('900','961','CA'),('967','968','HI'),('970','979','OR'),('980','994','WA'),
    ('995','999','AK');

-- Pricing inputs on device listings.
alter table public.host_devices
    add column gpu_model text references public.gpu_rates(gpu_model) on update cascade,
    add column zip text check (zip is null or zip ~ '^[0-9]{5}$'),
    add column usd_per_kwh_override numeric(6,4)
        check (usd_per_kwh_override is null or usd_per_kwh_override between 0.01 and 2),
    add column green_energy boolean not null default false,
    -- Written only by the host dashboard heartbeat (service role); used for "available now".
    add column last_seen_at timestamptz;
grant insert (gpu_model, zip, usd_per_kwh_override, green_energy),
      update (gpu_model, zip, usd_per_kwh_override, green_energy)
    on public.host_devices to authenticated;

-- Everything /api/quote needs for any listed device, without exposing its owner or ZIP.
create function public.quote_inputs(p_device_id uuid, p_priority text)
returns table (
    gpu_model text, gpu_label text, vram_gb int, base_rate_usd_hr numeric, power_kw numeric,
    usd_per_kwh numeric, kwh_source text, green_energy boolean, priority_multiplier numeric,
    host_share numeric, floor_margin numeric, reserve_multiplier numeric
)
language sql stable security definer set search_path = ''
as $$
    select g.gpu_model, g.label, g.vram_gb, g.base_rate_usd_hr, g.power_kw + s.system_overhead_kw,
           coalesce(d.usd_per_kwh_override, st.usd_per_kwh, us.usd_per_kwh),
           case when d.usd_per_kwh_override is not null then 'host'
                when st.usd_per_kwh is not null then 'state' else 'national' end,
           d.green_energy, p.multiplier, s.host_share, s.floor_margin, s.reserve_multiplier
    from public.host_devices d
    left join public.grove_settings s on true
    left join public.gpu_rates g on g.gpu_model = d.gpu_model and g.active
    left join public.priority_levels p on p.id = p_priority
    left join public.zip3_ranges z on left(d.zip, 3) between z.zip3_start and z.zip3_end
    left join public.electricity_rates st on st.state = z.state
    left join public.electricity_rates us on us.state = 'US'
    where d.id = p_device_id;
$$;
revoke execute on function public.quote_inputs(uuid, text) from public, anon;
grant execute on function public.quote_inputs(uuid, text) to authenticated;
