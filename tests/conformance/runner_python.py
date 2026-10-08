# Conformance runner (Python). Runs every vector against the bench database and prints
# {"<vector>": {"statements": [{"sql", "binds", "kind", "tables", "transaction", "error"}],
# "result": …}} with the same chains, result shapes, and masking as runner_go. Each
# statement is its statement event: transaction is renumbered from 1 in order of appearance
# within the vector, null outside a transaction, and error is the code of the statement's
# error or null. Result maps are written with sorted keys and the top level is sorted by
# vector name, as the Go encoder writes them.
#
# Usage: python3 tests/conformance/runner_python.py --models DIR --dsn URI [--vector NAME]...
# DIR holds the models.py that orm-gen writes from schema/bench.dbs (conformance-python-models).
# Each --vector selects one vector by name; without one every vector runs.
import datetime
import json
import os
import sys
from decimal import Decimal

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'packages', 'orm-python', 'src'))
sys.path.insert(0, os.path.join(ROOT, '..', 'ordered-json', 'python', 'src'))

USAGE = 'usage: runner_python.py --models DIR --dsn URI [--vector NAME]...'


def parse_args(args):
    dsn = None
    models = None
    vectors = []
    i = 0
    while i < len(args):
        flag = args[i]
        value = args[i + 1] if i + 1 < len(args) else ''
        if value == '':
            print(f'{flag} requires a nonempty value; {USAGE}', file=sys.stderr)
            sys.exit(2)
        if flag == '--dsn' and dsn is None:
            dsn = value
        elif flag == '--models' and models is None:
            models = value
        elif flag == '--vector':
            if value in vectors:
                print(f'vector {value} is selected twice', file=sys.stderr)
                sys.exit(2)
            vectors.append(value)
        else:
            print(f'unexpected argument {flag}; {USAGE}', file=sys.stderr)
            sys.exit(2)
        i += 2
    if dsn is None:
        print(f'--dsn is required; {USAGE}; give the DSN of the bench database with --dsn', file=sys.stderr)
        sys.exit(2)
    if models is None:
        print(f'--models is required; {USAGE}; run make conformance-python-models, which writes the models', file=sys.stderr)
        sys.exit(2)
    return dsn, models, vectors


# Set by main() from the arguments; importing this module parses nothing.
DSN, MODELS_DIR, SELECTED = None, None, []
bench = Author = CompositeAccount = Service = ServiceMember = ServiceRegion = None
User = SoftRecord = Task = None

log = []
transactions = {}
mask_seqs = set()
mask_ts = set()

BIG = 2 ** 53 - 1


def pad(n, width=2):
    return str(n).rjust(width, '0')


def time_text(d):
    return (f'{d.year}-{pad(d.month)}-{pad(d.day)} {pad(d.hour)}:{pad(d.minute)}:{pad(d.second)}.'
            f'{pad(d.microsecond // 1000, 3)}000')


def norm(v):
    """Renders a bound value the way every runner does."""
    if isinstance(v, bool):
        return v
    if isinstance(v, int):
        if v > BIG or v < -BIG:
            raise ValueError('integer query bind exceeds the exact JSON range')
        return '$SEQ' if v in mask_seqs else v
    if isinstance(v, datetime.datetime):
        return norm(time_text(v))
    if isinstance(v, (bytes, bytearray)):
        if bytes(v[:8]) == b'ORM-AES2' and bytes(v[8:9]) == b'\0':
            if len(v) < 9 + 12 + 16:
                raise ValueError('invalid AES ciphertext bind')
            return '$AES'
        return norm(bytes(v).decode('utf-8'))
    if isinstance(v, str):
        if v in mask_ts:
            return '$TS'
        if v.startswith('ORM-AES2'):
            raise ValueError('invalid AES ciphertext bind')
        if v.lower().startswith('4f524d2d41455332'):
            if len(v) % 2 != 0 or any(c not in '0123456789abcdefABCDEF' for c in v):
                raise ValueError('invalid hex AES ciphertext bind')
            decoded = bytes.fromhex(v)
            if decoded[:9] != b'ORM-AES2\0' or len(decoded) < 9 + 12 + 16:
                raise ValueError('invalid hex AES ciphertext bind')
            return '$AES'
    return v


def code_of(error):
    if error is None:
        return None
    value = getattr(error, 'code', None)
    if isinstance(value, str) and value != '':
        return value
    return str(error)


def caught(fn):
    try:
        fn()
        return None
    except Exception as error:  # noqa: BLE001 - every library error is the result of the vector
        return code_of(error)


def mask(seqs, *times):
    for s in seqs:
        mask_seqs.add(int(s))
    for t in times:
        mask_ts.add(t)
    for s in log:
        s['binds'] = [norm(b) for b in s['binds']]


def pick(m, *names):
    if m is None:
        return None
    row = m.to_array()
    out = {}
    for n in names:
        if n not in row:
            raise ValueError(f'missing selected field: {n}')
        out[n] = row[n]
    return out


def picks(rows, *names):
    return [pick(m, *names) for m in rows.values()]


def sorted_maps(v):
    """Writes every map of a result with sorted keys, as the Go encoder does."""
    if isinstance(v, dict):
        return {k: sorted_maps(v[k]) for k in sorted(v)}
    if isinstance(v, list):
        return [sorted_maps(x) for x in v]
    return v


def derived_integer(value):
    if isinstance(value, bool):
        raise ValueError('invalid derived integer')
    if isinstance(value, int):
        if -(2 ** 63) <= value < 2 ** 63:
            return value
    if isinstance(value, str) and value.lstrip('-').isdigit() and (value == '0' or value.lstrip('-')[0] != '0'):
        integer = int(value)
        if -(2 ** 63) <= integer < 2 ** 63:
            return integer
    raise ValueError('invalid derived integer')


def on_event(e):
    transaction = None
    if e.transaction is not None:
        if e.transaction not in transactions:
            transactions[e.transaction] = len(transactions) + 1
        transaction = transactions[e.transaction]
    log.append({'sql': e.sql, 'binds': [norm(b) for b in e.binds], 'kind': e.kind,
                'tables': list(e.tables), 'transaction': transaction,
                'error': None if e.error is None else code_of(e.error)})


def go_float(f):
    """Formats a float64 the way encoding/json does: shortest digits, no exponent in [1e-6, 1e21)."""
    if f == 0:
        return '0'
    text = repr(f)
    a = abs(f)
    if 1e-6 <= a < 1e21:
        if 'e' not in text:
            return text[:-2] if text.endswith('.0') else text
        mantissa, exp = text.split('e')
        digits = mantissa.replace('.', '').replace('-', '')
        point = mantissa.replace('-', '').find('.')
        point = len(mantissa.replace('-', '')) if point < 0 else point
        shift = int(exp) + point
        sign = '-' if f < 0 else ''
        if shift <= 0:
            return sign + '0.' + '0' * (-shift) + digits
        if shift >= len(digits):
            return sign + digits + '0' * (shift - len(digits))
        return sign + digits[:shift] + '.' + digits[shift:]
    # exponent form with at least two exponent digits, as encoding/json writes it
    mantissa, _, exp = repr(f).partition('e')
    sign = '-' if exp.startswith('-') else '+'
    digits = exp.lstrip('+-').rjust(2, '0')
    return f'{mantissa}e{sign}{digits}'


def encode(value, indent=0):
    """Encodes the output the way the Go encoder does: one space per level, Go escapes."""
    pad_text = ' ' * indent
    if isinstance(value, dict):
        if not value:
            return '{}'
        items = [f'{pad_text} {json.dumps(k, ensure_ascii=False)}: {encode(v, indent + 1)}' for k, v in value.items()]
        return '{\n' + ',\n'.join(items) + '\n' + pad_text + '}'
    if isinstance(value, list):
        if not value:
            return '[]'
        items = [f'{pad_text} {encode(v, indent + 1)}' for v in value]
        return '[\n' + ',\n'.join(items) + '\n' + pad_text + ']'
    if value is None:
        return 'null'
    if value is True:
        return 'true'
    if value is False:
        return 'false'
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return go_float(value)
    if isinstance(value, Decimal):
        return go_float(float(value))
    return json.dumps(value, ensure_ascii=False)


def go_escape(text):
    return (text.replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
            .replace('\u2028', '\\u2028').replace('\u2029', '\\u2029'))


def load_models():
    global bench, Author, CompositeAccount, Service, ServiceMember, ServiceRegion, User, SoftRecord, Task
    sys.path.insert(0, MODELS_DIR)
    import models as generated  # noqa: E402  (generated from schema/bench.dbs)
    bench = generated
    Author, CompositeAccount, Service, ServiceMember, ServiceRegion = (
        bench.Author, bench.CompositeAccount, bench.Service, bench.ServiceMember, bench.ServiceRegion)
    User, SoftRecord, Task = bench.User, bench.SoftRecord, bench.Task


def main():
    global DSN, MODELS_DIR, SELECTED
    DSN, MODELS_DIR, SELECTED = parse_args(sys.argv[1:])
    load_models()
    from polyspec.orm.aes import AesKeyring  # noqa: E402
    from polyspec.orm.values import orm  # noqa: E402
    db = bench.connect(DSN, aesKey='bench-salt', blindIndexKey='bench-blind-index')
    db.subscribe(on_event)
    global log, transactions, mask_seqs, mask_ts
    out = {}
    declared = set()
    write_vectors = {'write_cycle', 'now_defaults', 'required_columns', 'creates_and_save', 'delete_recursive'}

    def run(name, fn):
        declared.add(name)
        if SELECTED and name not in SELECTED:
            return
        global log, transactions, mask_seqs, mask_ts
        log, transactions, mask_seqs, mask_ts = [], {}, set(), set()
        if name in write_vectors:
            result = db.transaction(fn, {'retry': 0})
        else:
            result = fn()
        out[name] = {'statements': [dict(s) for s in log], 'result': sorted_maps(result)}

    def author():
        return Author().connect(db)

    cols = ['seq', 'name', 'is_close', 'is_display', 'read_count']

    # The vectors below follow tests/conformance/runner_typescript.mjs, one function per vector.
    run('conditions_connectors', lambda: picks(
        author().service_seq(7).and_is_close(False).or_().read_count(6).order_by_seq_asc().limit(0, 3).gets(), *cols))

    run('conditions_group', lambda: picks(
        author().service_seq(7)
        .and_(lambda q: q.is_display(False).or_(lambda q2: q2.is_close(True).and_gt_read_count(500)))
        .order_by_seq_desc().limit(0, 3).gets(), *cols))

    run('conditions_leading_group', lambda: picks(
        author().and_(lambda q: q.is_display(False).or_is_close(True))
        .and_service_seq(7).order_by_seq_desc().limit(0, 3).gets(), *cols))

    run('conditions_leading_prefix', lambda: picks(
        author().and_service_seq(7).and_gt_read_count(990).order_by_seq_desc().limit(0, 3).gets(), *cols))

    def conditions_values():
        queries = [
            author().service_seq([7, 8]).and_ne_is_close(True),
            author().service_seq(7).and_uuid(None),
            author().service_seq(7).and_ne_photo_url(None),
            author().service_seq(7).and_ne_read_count([6, 106, 206]),
            author().service_seq(7).and_between_read_count([100, 200]),
            author().service_seq(7).and_lk_name('uthor-10'),
            author().service_seq(7).and_lb_name('Author-10'),
            author().service_seq(7).and_ge_read_count(990),
            author().service_seq(7).and_le_read_count(10),
            author().service_seq(7).and_lt_seq(1000),
        ]
        return [q.get_count() for q in queries]
    run('conditions_values', conditions_values)

    def terminal_by():
        one = author().get_by_seq(42)
        missing = caught(lambda: author().get_by_seq(-1))
        rows = author().order_by_seq_asc().limit(0, 2).gets_by_service_seq_and_is_close(7, False)
        count = author().get_count_by_service_seq(7)
        return {'one': pick(one, *cols), 'missing': missing, 'rows': picks(rows, *cols), 'count': count}
    run('terminal_by', terminal_by)

    def terminal_reuse():
        q = author().service_seq(7).order_by_seq_asc().limit(0, 2)
        first = q.get_count_by_is_close(True)
        rows = q.gets()
        last = q.get_count()
        return [first, len(rows.values()), last]
    run('terminal_reuse', terminal_reuse)

    def expression_forms():
        count = author().service_seq(7).and_not(lambda q: q.is_close(True).or_gt_read_count(500)).get_count()
        rows = author().not_(lambda q: q.is_display(False)).and_service_seq(7).order_by_seq_desc().limit(0, 3).gets()
        or_count = author().service_seq(7).or_not(lambda q: q.lt_read_count(990)).get_count()
        return {'count': count, 'rows': picks(rows, 'seq', 'is_display'), 'or_count': or_count}
    run('expression_forms', expression_forms)

    def columns():
        none = Service().connect(db).remove_all_columns().get_by_seq(7)
        added = author().remove_all_columns().add_column_name().add_column_start_dt_alias_start_year(orm.year()).get_by_seq(42)
        removed = Service().connect(db).remove_column_name().get_by_seq(7)
        return [none.to_array(), pick(added, 'seq', 'name', 'start_year'), removed.to_array()]
    run('columns', columns)

    def joins():
        service = Service().on(lambda s: s.gt_seq(0)).name('service-7')
        rows = (author().remove_all_columns().add_column_name()
                .join_service_seq_with_seq(service)
                .is_close(False)
                .and_(lambda q: q.is_display(True).or_(service))
                .order_by_seq_asc().limit(0, 2).gets())
        member = ServiceMember()
        compared = (author().join_service_member_seq_with_seq(member)
                    .service_seq(7).and_success_count_lt_seq(member).get_count())
        left = (author().left_join_service_region_seq_with_seq(ServiceRegion().alias_module())
                .service_seq(7).order_by_seq_asc().limit(0, 1).gets())
        return {'rows': rows.to_array_list() if hasattr(rows, 'to_array_list') else [r.to_array() for r in rows.values()],
                'compared': compared, 'module': pick(left.first().get_module(), 'seq', 'name')}
    run('joins', joins)

    def relations():
        rows = (author().remove_all_columns().add_column_name().add_column_is_close()
                .relation(User().match_user_seq_with_seq().alias_writer()
                          .relations(Author().match_seq_with_user_seq().remove_all_columns()
                                     .order_by_seq_desc().group_limit(2)))
                .relation(Service().match_service_seq_with_seq()
                          .relations(ServiceMember().match_seq_with_service_seq().remove_all_columns()
                                     .order_by_seq_asc().group_limit(2).key_name_user_seq()))
                .relation(ServiceRegion().match_service_region_seq_with_seq().possible_is_close(True).parent_node())
                .service_seq(7).order_by_seq_asc().limit(0, 3).gets())
        return [r.to_array() for r in rows.values()]
    run('relations', relations)

    def relation_empty():
        rows = author().relations(ServiceMember().match_user_seq_with_user_seq()).gets_by_seq(-1)
        return len(rows.values())
    run('relation_empty', relation_empty)

    def subqueries():
        users = (User().connect(db)
                 .add_column_read_total(lambda u: Author().sum_read_count().user_seq_eq_seq(u).and_service_seq(7))
                 .seq(Author().add_column_user_seq().service_seq(7).and_ge_read_count(906))
                 .order_by_seq_asc().gets())
        return [[u.get_seq(), derived_integer(u.get_read_total())] for u in users.values()]
    run('subqueries', subqueries)

    def aggregates():
        total = author().service_seq(7).sum_read_count().get_sum()
        average = author().service_seq(7).avg_like_count().get_avg()
        import struct
        if struct.pack('>d', average).hex() != '404805c28f5c28f6':
            raise ValueError(f'aggregate average has unexpected binary64 value: {average}')
        groups = author().service_seq(7).group_by_is_close().order_by_is_close_asc().gets_count()
        page = author().service_seq(7).remove_all_columns().order_by_seq_asc().gets_page(3, 4)
        return {
            'sum': total,
            'avg': f'{average:.4f}',
            'groups': groups.to_array(),
            'page': {'keys': list(page['items'].keys()), 'total': page['totalCount'], 'pages': page['totalPages'],
                     'page': page['page'], 'per_page': page['perPage']},
        }
    run('aggregates', aggregates)

    def functions():
        queries = [
            author().service_seq(7).and_eq_start_dt(orm.day_of_week(), 2),
            author().service_seq(7).and_start_dt(orm.year(), 2026),
            author().service_seq(7).and_gt_start_dt(orm.days_ago(36500)),
            author().service_seq(7).and_lt_start_dt(orm.months_later(1200)),
        ]
        counts = [q.get_count() for q in queries]
        rows = (author().remove_all_columns().add_column_start_dt_alias_start_month(orm.month())
                .order_by_start_dt_asc(orm.year()).order_by_seq_asc().gets_by_seq([42, 43]))
        return {'counts': counts, 'months': [derived_integer(r.get_start_month()) for r in rows.values()]}
    run('functions', functions)

    def errors():
        errs = []

        def attempt(fn):
            errs.append(caught(lambda: fn()))
        attempt(lambda: author().name('a').is_close(True).gets())
        attempt(lambda: author().name('a').and_().gets())
        attempt(lambda: author().seq([]).gets())
        attempt(lambda: Author().name('a').gets())
        attempt(lambda: author().for_update().gets())
        attempt(lambda: author().join_user_seq_with_seq(User().connect(db)).gets())
        attempt(lambda: author().limit(0, 1).gets_page(1, 10))
        attempt(lambda: author().relation(User().match_user_seq_with_seq().limit(0, 1)).gets_by_seq(42))
        attempt(lambda: author().name('a').or_(User()).gets())
        return errs
    run('errors', errors)

    def get_query():
        st = (author().service_seq(7).and_lk_name('x').and_aes_hex_email('user7@example.com')
              .order_by_seq_desc().limit(0, 5).get_query())
        return {'sql': st['sql'], 'binds': [norm(b) for b in st['binds']]}
    run('get_query', get_query)

    def aes_values():
        row = author().remove_all_columns().add_column_aes_hex_email().add_column_aes_hex_phone().get_by_seq(42)
        found = author().aes_hex_email('user42@example.com').get_count()
        return {'row': row.to_array(), 'found': found}
    run('aes_values', aes_values)

    def write_cycle():
        import datetime as dt
        start = dt.datetime(2026, 6, 1, tzinfo=dt.timezone.utc)
        created = (author().set_name('cycle').set_user_seq(1).set_service_seq(999).set_service_region_seq(1)
                   .set_service_member_seq(1).set_start_dt(start).set_end_dt(start).set_price('12.500')
                   .set_ip('10.0.0.1').set_aes_hex_email('cycle@example.com')
                   .set_json_setting(bench_styled({'a': 1})).set_serialize_data(bench_styled({'k': 'v'}))
                   .new_label('created').create())
        seq = created.get_seq()
        mask([seq])
        created_array = created.to_array()
        created_array['seq'] = '$SEQ'
        loaded = author().add_all_columns().get_by_seq(seq)
        mask([], loaded.get_updated_ts())
        loaded.set_name('cycle-2').plus_read_count(3).update(True)
        stale = caught(lambda: loaded.set_name('stale').update(True))
        again = author().add_all_columns().get_by_seq(seq)
        updated = pick(again, 'name', 'read_count', 'price', 'ip', 'aes_hex_email', 'json_setting',
                       'serialize_data', 'start_dt')
        again.delete()
        gone = caught(lambda: author().get_by_seq(seq))
        return {'created': created_array, 'updated': updated, 'stale': stale, 'deleted': gone}
    run('write_cycle', write_cycle)

    def now_defaults():
        import time
        before = time.time()
        start = datetime.datetime(2026, 6, 1, tzinfo=datetime.timezone.utc)
        created = (author().set_name('clock').set_user_seq(1).set_service_seq(999).set_service_region_seq(1)
                   .set_service_member_seq(1).set_start_dt(start).set_end_dt(start).create())
        seq = created.get_seq()
        mask([seq])
        loaded = author().get_by_seq(seq)
        created_ts = loaded.get_created_ts()
        updated_ts = loaded.get_updated_ts()
        parsed = datetime.datetime.strptime(created_ts, '%Y-%m-%d %H:%M:%S.%f').replace(tzinfo=datetime.timezone.utc)
        near = abs(parsed.timestamp() - before) < 60
        loaded.delete()
        return {'created_near_clock': near, 'created_equals_updated': created_ts == updated_ts}
    run('now_defaults', now_defaults)

    def required_columns():
        def failure(fn):
            try:
                fn()
            except Exception as error:  # noqa: BLE001
                return {'error': code_of(error), 'message': str(error)}
            return None
        missing_state = failure(lambda: Task().connect(db).set_title('draft').create())
        missing_title = failure(lambda: Task().connect(db).set_state('open').create())
        created = Task().connect(db).set_title('draft').set_state('open').create()
        mask([created.get_seq()])
        created.delete()
        return {'missing_state': missing_state, 'missing_title': missing_title}
    run('required_columns', required_columns)

    def creates_and_save():
        rows = [
            CompositeAccount().set_tenant_id(900).set_account_id(1).set_name('a'),
            CompositeAccount().set_tenant_id(900).set_account_id(2).set_name('b'),
            CompositeAccount().set_tenant_id(901).set_account_id(1).set_name('c'),
        ]
        inserted = CompositeAccount().connect(db).creates(rows)
        CompositeAccount().connect(db).set_tenant_id(900).set_account_id(1).set_name('dup') \
            .duplication(CompositeAccount().set_name('updated')).create()
        CompositeAccount().connect(db).set_tenant_id(900).set_account_id(2).set_name('saved').save()
        pairs = (CompositeAccount().connect(db)
                 .tuple_tenant_id_with_account_id([[900, 1], [900, 2]])
                 .order_by_account_id_asc().gets())
        everything = (CompositeAccount().connect(db).tenant_id([900, 901])
                      .order_by_tenant_id_asc().order_by_account_id_asc().gets())
        everything.delete()
        left = CompositeAccount().connect(db).tenant_id([900, 901]).get_count()
        return {'inserted': inserted, 'pairs': pairs.to_array(), 'left': left}
    run('creates_and_save', creates_and_save)

    def delete_recursive():
        service = Service().connect(db).set_name('recursive').create()
        seq = service.get_seq()
        seqs = [seq]
        for i in range(2):
            member = ServiceMember().connect(db).set_service_seq(seq).set_user_seq(i + 1).create()
            seqs.append(member.get_seq())
        loaded = Service().connect(db).relations(ServiceMember().match_seq_with_service_seq()).get_by_seq(seq)
        members = len(loaded.get_service_member_models())
        mask(seqs)
        loaded.delete(True)
        left = ServiceMember().connect(db).get_count_by_service_seq(seq)
        service2 = caught(lambda: Service().connect(db).get_by_seq(seq))
        return {'members': members, 'members_left': left, 'service_left': service2}
    run('delete_recursive', delete_recursive)

    def transactions_vector():
        class Boom(Exception):
            pass
        events = []
        failed = None
        try:
            def outer():
                Service().set_name('tx-outer').create()
                try:
                    def inner():
                        Service().set_name('tx-inner').create()
                        raise Boom()
                    db.transaction(inner)
                    events.append(False)
                except Boom:
                    events.append(True)
                events.append(Service().name(['tx-outer', 'tx-inner']).get_count())
                locked = Service().name('tx-outer').for_update().gets()
                events.append(len(locked.values()))
                db.utils().lock('conformance')
                db.utils().set_local('ormtest.actor', 'runner')
                events.append(db.utils().local('ormtest.actor'))
                raise Boom()
            db.transaction(outer, {'retry': 0})
        except Boom as error:
            failed = error
        events.append(failed is not None)
        events.append(Service().connect(db).name(['tx-outer', 'tx-inner']).get_count())
        return events
    run('transactions', transactions_vector)

    def restore():
        class Boom(Exception):
            pass
        result = {}
        failed = None
        try:
            def body():
                created = SoftRecord().set_name('restore').create()
                seq = created.get_seq()
                mask([seq])
                created.set_deleted_at(datetime.datetime(2026, 1, 2, 3, 4, 5, tzinfo=datetime.timezone.utc)).update()
                result['hidden'] = caught(lambda: SoftRecord().get_by_seq(seq))
                for name, value in [('restored', 'restore-2'), ('again', 'ignored')]:
                    array = SoftRecord().set_seq(seq).set_name(value).restore().to_array()
                    array['seq'] = '$SEQ'
                    result[name] = array
                result['missing'] = caught(lambda: SoftRecord().set_seq(0).restore())
                raise Boom()
            db.transaction(body, {'retry': 0})
        except Boom as error:
            failed = error
        if failed is None:
            raise RuntimeError('restore transaction did not roll back')
        result['left'] = SoftRecord().connect(db).name('restore').get_count()
        return result
    run('restore', restore)

    def aes_status():
        keyring = AesKeyring({1: 'bench-salt'}, 1)
        status = db.utils().aes().status(Author(), keyring)
        versions = sorted(f'{v}:{n}' for v, n in status.versions.items())
        return {'current': status.current, 'pending': status.pending, 'versions': ','.join(versions)}
    run('aes_status', aes_status)

    db.close()
    unknown = [name for name in SELECTED if name not in declared]
    if unknown:
        print(f'unknown vector {", ".join(unknown)}', file=sys.stderr)
        sys.exit(2)
    text = encode(dict(sorted(out.items())))
    sys.stdout.write(go_escape(text) + '\n')


def bench_styled(value):
    from polyspec.orm.styled_value import StyledValue
    return StyledValue.value(value)


if __name__ == '__main__':
    main()
