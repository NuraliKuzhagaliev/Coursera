alter table coursera_queue.licenses add column subscription_id text not null default '';
alter table coursera_queue.licenses drop constraint licenses_pkey;
alter table coursera_queue.licenses add primary key(user_id,source,subscription_id);
-- Unknown legacy Stripe subscriptions must be reconciled by a signed webhook.
update coursera_queue.licenses set status='revoked' where source='stripe';

create or replace function public.cq_dispatch(secret text, operation text, payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  cfg coursera_queue.config%rowtype;
  account coursera_queue.accounts%rowtype;
  session_row coursera_queue.sessions%rowtype;
  plan coursera_queue.plans%rowtype;
  license_row coursera_queue.licenses%rowtype;
  uid uuid;
  auth_id uuid;
  auth_created timestamptz;
  actual_email text;
  confirmed timestamptz;
  banned timestamptz;
  active_created timestamptz;
  session_token_hash text;
  used integer;
  rate_used integer;
  target uuid;
  found_active boolean;
  snapshot jsonb;
begin
  select * into cfg from coursera_queue.config where id;
  if cfg.backend_key_hash is null or secret is null or
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(secret,'UTF8')),'hex') <> cfg.backend_key_hash then
    return jsonb_build_object('error','server_auth_required');
  end if;

  if operation = 'config' then
    return jsonb_build_object('release',jsonb_build_object('minimumVersion',cfg.minimum_version,
      'latestVersion',cfg.latest_version,'notice',cfg.notice),'plans',
      (select coalesce(jsonb_agg(to_jsonb(p)),'[]') from coursera_queue.plans p where enabled));
  end if;

  if operation = 'billing.claim' then
    if exists(select 1 from coursera_queue.payments where event_id=payload->>'eventId') then
      return '{"done":true}';
    end if;
    insert into coursera_queue.billing_locks(subscription_id,owner,expires_at)
    values(payload->>'subscriptionId',(payload->>'owner')::uuid,now()+interval '30 seconds')
    on conflict(subscription_id) do update set owner=excluded.owner,expires_at=excluded.expires_at
      where coursera_queue.billing_locks.expires_at < now();
    if not found then return '{"error":"billing_busy"}'; end if;
    return '{"claimed":true}';
  end if;
  if operation = 'billing.commit' then
    perform 1 from coursera_queue.billing_locks where subscription_id=payload->>'subscriptionId'
      and owner=(payload->>'owner')::uuid and expires_at>now() for update;
    if not found then return '{"error":"billing_busy"}'; end if;
    select * into account from coursera_queue.accounts where stripe_customer=payload->>'customerId' for update;
    if not found then return '{"error":"unknown_customer"}'; end if;
    select * into plan from coursera_queue.plans where stripe_price_id=payload->>'priceId' and enabled;
    if not found or plan.amount <> (payload->>'amount')::integer or plan.currency <> payload->>'currency' then
      return '{"error":"price_mismatch"}';
    end if;
    insert into coursera_queue.payments(event_id,user_id,subscription_id,status,amount,currency)
    values(payload->>'eventId',account.user_id,payload->>'subscriptionId',payload->>'status',plan.amount,plan.currency)
    on conflict do nothing;
    if found then
      insert into coursera_queue.licenses(user_id,source,plan_id,status,expires_at,subscription_id)
      values(account.user_id,'stripe',plan.id,
        case when (payload->>'paid')::boolean and payload->>'status'='active' then 'active' else 'revoked' end,
        to_timestamp((payload->>'periodEnd')::double precision),payload->>'subscriptionId')
      on conflict(user_id,source,subscription_id) do update set plan_id=excluded.plan_id,status=excluded.status,expires_at=excluded.expires_at;
    end if;
    delete from coursera_queue.billing_locks where subscription_id=payload->>'subscriptionId'
      and owner=(payload->>'owner')::uuid;
    return '{"ok":true}';
  end if;

  uid := (payload->>'userId')::uuid;
  auth_id := (payload->>'authSession')::uuid;
  select u.email,u.email_confirmed_at,u.banned_until,s.created_at into actual_email,confirmed,banned,auth_created
    from auth.users u join auth.sessions s on s.user_id=u.id
    where u.id=uid and s.id=auth_id and (s.not_after is null or s.not_after>now());
  if not found or confirmed is null or banned>now() then return '{"error":"auth_required"}'; end if;

  if operation='session.open' then
    insert into coursera_queue.accounts(user_id,email) values(uid,actual_email)
    on conflict(user_id) do update set email=excluded.email;
  end if;
  select * into account from coursera_queue.accounts where user_id=uid for update;
  if not found then return '{"error":"session_required"}'; end if;
  if account.blocked then return '{"error":"account_blocked"}'; end if;
  if account.device_lock and account.registered_device is not null and
    account.registered_device <> payload->>'deviceId' then return '{"error":"device_locked"}'; end if;
  session_token_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(payload->>'sessionToken','UTF8')),'hex');

  if operation='session.open' then
    select a.created_at into active_created from coursera_queue.sessions c
      join auth.sessions a on a.id=c.auth_session
      where c.id=account.active_session and c.revoked_at is null;
    if active_created is not null and auth_created<active_created then return '{"error":"session_revoked"}'; end if;
    select * into session_row from coursera_queue.sessions where user_id=uid and auth_session=auth_id
      and token_hash=session_token_hash and revoked_at is null;
    if not found then
      if exists(select 1 from coursera_queue.sessions where auth_session=auth_id) then
        return '{"error":"session_revoked"}';
      end if;
      update coursera_queue.sessions set revoked_at=now() where user_id=uid and revoked_at is null;
      insert into coursera_queue.sessions(id,user_id,auth_session,token_hash,device_id)
        values((payload->>'sessionId')::uuid,uid,auth_id,session_token_hash,payload->>'deviceId') returning * into session_row;
      update coursera_queue.accounts set active_session=session_row.id,
        registered_device=coalesce(registered_device,payload->>'deviceId') where user_id=uid;
      insert into coursera_queue.audit(actor,action) values(uid,'session.open');
    end if;
  else
    select * into session_row from coursera_queue.sessions where id=account.active_session and user_id=uid
      and auth_session=auth_id and token_hash=session_token_hash and revoked_at is null
      and device_id=payload->>'deviceId';
    if not found then return '{"error":"session_revoked"}'; end if;
    update coursera_queue.sessions set last_seen=now() where id=session_row.id;
  end if;

  if operation='session.close' then
    update coursera_queue.sessions set revoked_at=now() where id=session_row.id;
    update coursera_queue.accounts set active_session=null where user_id=uid;
    return '{"ok":true}';
  end if;
  if operation='account.identity' then
    update coursera_queue.accounts set display_name=left(payload->>'name',200) where user_id=uid;
    return '{"ok":true}';
  end if;
  if operation='billing.customer' then
    update coursera_queue.accounts set stripe_customer=coalesce(stripe_customer,payload->>'customerId') where user_id=uid;
    return '{"ok":true}';
  end if;

  select l.* into license_row from coursera_queue.licenses l join coursera_queue.plans p on p.id=l.plan_id
    where l.user_id=uid and l.status='active' and l.expires_at>now() and p.enabled and not account.license_revoked
    order by p.daily_quota desc,l.expires_at desc limit 1;
  found_active := found;
  if found_active then select * into plan from coursera_queue.plans where id=license_row.plan_id; end if;
  select count into used from coursera_queue.usage where user_id=uid and day=current_date;
  snapshot := jsonb_build_object('userId',uid,'email',actual_email,'name',account.display_name,'role',account.role,
    'active',found_active,'plan',case when found_active then to_jsonb(plan) else null end,
    'expiresAt',license_row.expires_at,'used',coalesce(used,0),'customerId',account.stripe_customer,
    'deviceLocked',account.device_lock,'release',jsonb_build_object('minimumVersion',cfg.minimum_version,
      'latestVersion',cfg.latest_version,'notice',cfg.notice));
  if operation in ('session.open','status') then return snapshot; end if;

  if operation like 'admin.%' then
    if account.role<>'admin' then return '{"error":"admin_required"}'; end if;
    if operation='admin.snapshot' then
      return jsonb_build_object('users',(select coalesce(jsonb_agg(to_jsonb(a)),'[]') from coursera_queue.accounts a),
        'licenses',(select coalesce(jsonb_agg(to_jsonb(l)),'[]') from coursera_queue.licenses l),
        'sessions',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'userId',s.user_id,
          'deviceId',s.device_id,'lastSeen',s.last_seen,'revokedAt',s.revoked_at)),'[]') from coursera_queue.sessions s),
        'plans',(select jsonb_agg(to_jsonb(p)) from coursera_queue.plans p),
        'payments',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from
          (select * from coursera_queue.payments order by created_at desc limit 100) t),
        'usage',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from coursera_queue.usage t where day=current_date),
        'audit',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from
          (select * from coursera_queue.audit order by id desc limit 100) t),'release',snapshot->'release');
    end if;
    target := nullif(payload->>'targetUser','')::uuid;
    if operation='admin.license' then
      insert into coursera_queue.licenses(user_id,source,plan_id,status,expires_at)
      values(target,'manual',payload->>'planId','active',(payload->>'expiresAt')::timestamptz)
      on conflict(user_id,source,subscription_id) do update set plan_id=excluded.plan_id,status=excluded.status,expires_at=excluded.expires_at;
      update coursera_queue.accounts set license_revoked=false where user_id=target;
    elsif operation='admin.revoke' then
      update coursera_queue.accounts set license_revoked=true where user_id=target;
      update coursera_queue.licenses set status='revoked' where user_id=target;
    elsif operation='admin.block' then
      update coursera_queue.accounts set blocked=(payload->>'blocked')::boolean where user_id=target;
    elsif operation='admin.device' then
      update coursera_queue.accounts set device_lock=(payload->>'locked')::boolean,
        registered_device=case when (payload->>'reset')::boolean then null else registered_device end where user_id=target;
    elsif operation='admin.session' then
      update coursera_queue.sessions set revoked_at=now() where id=(payload->>'targetSession')::uuid;
    elsif operation='admin.plan' then
      insert into coursera_queue.plans(id,name,daily_quota,requests_per_minute,stripe_price_id,amount,currency,enabled)
      values(payload->>'id',payload->>'name',(payload->>'dailyQuota')::integer,(payload->>'rpm')::integer,
        nullif(payload->>'stripePriceId',''),(payload->>'amount')::integer,payload->>'currency',(payload->>'enabled')::boolean)
      on conflict(id) do update set name=excluded.name,daily_quota=excluded.daily_quota,
        requests_per_minute=excluded.requests_per_minute,stripe_price_id=excluded.stripe_price_id,
        amount=excluded.amount,currency=excluded.currency,enabled=excluded.enabled;
    elsif operation='admin.release' then
      update coursera_queue.config set minimum_version=payload->>'minimumVersion',
        latest_version=payload->>'latestVersion',notice=payload->>'notice' where id;
    else return '{"error":"unknown_operation"}';
    end if;
    insert into coursera_queue.audit(actor,action,details) values(uid,operation,
      jsonb_strip_nulls(jsonb_build_object('targetUser',target,'targetSession',payload->>'targetSession','planId',payload->>'planId')));
    return '{"ok":true}';
  end if;

  if operation='checkout' then return snapshot; end if;
  if operation <> 'authorize' then return '{"error":"unknown_operation"}'; end if;
  if not found_active then return '{"error":"license_required"}'; end if;
  insert into coursera_queue.rate_limits(user_id,minute,count) values(uid,date_trunc('minute',now()),1)
  on conflict(user_id,minute) do update set count=coursera_queue.rate_limits.count+1 returning count into rate_used;
  if rate_used>plan.requests_per_minute then return '{"error":"rate_limited"}'; end if;
  if payload->>'kind'='prompt' then
    if exists(select 1 from coursera_queue.operations where user_id=uid
      and request_id=(payload->>'requestId')::uuid and request_hash<>coalesce(payload->>'requestHash','')) then
      return '{"error":"request_conflict"}';
    end if;
    if not exists(select 1 from coursera_queue.operations where user_id=uid and request_id=(payload->>'requestId')::uuid) then
      if coalesce(used,0)>=plan.daily_quota then return '{"error":"quota_exceeded"}'; end if;
      insert into coursera_queue.operations(user_id,request_id,request_hash)
        values(uid,(payload->>'requestId')::uuid,payload->>'requestHash');
      insert into coursera_queue.usage(user_id,day,count) values(uid,current_date,1)
      on conflict(user_id,day) do update set count=coursera_queue.usage.count+1;
    end if;
  end if;
  return snapshot;
exception
  when invalid_text_representation or not_null_violation or check_violation or foreign_key_violation then
    return '{"error":"invalid_request"}';
end;
$$;
revoke all on function public.cq_dispatch(text,text,jsonb) from public,authenticated;
grant execute on function public.cq_dispatch(text,text,jsonb) to anon;
comment on function public.cq_dispatch(text,text,jsonb) is 'Server-only RPC authenticated by a random backend credential. Never ship that credential to browser clients.';
