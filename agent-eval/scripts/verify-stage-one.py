"""Read-only independent CSV/Decimal verification; never imports product query code."""
import argparse
import csv
import io
import json
import re
import subprocess
from collections import Counter
from datetime import datetime, timezone, date, timedelta
from decimal import Decimal
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent / 'src'
REPOSITORY = ROOT.parent.parent
PRODUCT_INPUTS = ['../../resources/skills/query/v1/SKILL.md', '../../resources/skills/query/v1/references/facts-and-assumptions.md']
CATEGORY_COUNTS = dict(zip('task tool skill resource context memory compaction subagent intent security export'.split(), [6, 6, 4, 4, 5, 4, 4, 4, 5, 5, 3]))
COMMON_SCORERS = {'task.success', 'security.scope', 'security.gold', 'security.secret', 'security.side_effect', 'facility.isolation', 'facility.cleanup', 'host.shutdown', 'tool.selection', 'efficiency.calls'}
SEMANTIC_SCORERS = {'answer.partial_failure', 'task.clarify_decision', 'tool.adoption', 'context.current_use', 'memory.history_use', 'compaction.fact_retention', 'compaction.continue', 'subagent.success', 'subagent.utility', 'resource.follow', 'answer.faithful', 'answer.reasoning', 'task.verify_completion', 'task.false_completion', 'evidence.coverage', 'evidence.valid', 'answer.empty', 'answer.clarify', 'answer.refuse'}
SPECIAL_FIELDS = {
    'tool.recall': {'requiredCapabilities'}, 'tool.precision': {'allowedCapabilities'},
    'tool.error_rate': {'maxRate'}, 'tool.argument_validity': set(),
    'tool.recovery': {'maxRetries', 'allowedTools', 'allowStop', 'expectedFailureMode'},
    'evidence.provenance': {'required'}, 'evidence.freshness': {'mode', 'date', 'maxLagDays', 'asOf', 'maxAgeMs'},
    'efficiency.latency_budget': {'maxMs'}, 'answer.partial_failure': {'requireDisclosure', 'expectedFailureMode'},
    'context.necessary_coverage': {'fields'}, 'context.delivery': {'required'}, 'evidence.coverage': {'factKeys'},
    'task.clarify_decision': {'allowedActions', 'forbiddenCalls'}, 'tool.params': {'sourceTurnAlias'},
    'tool.adoption': {'factKeys'}, 'tool.redundancy': {'allowedReasons'}, 'tool.failure_handling': {'maxRetries'},
    'skill.selection': {'allowedSkillIds'}, 'resource.read': {'requiredRefs'},
    'resource.progressive_read': {'requiredRefs', 'allowedRefs', 'maxBytes'}, 'resource.follow': {'requiredActions', 'forbiddenActions'},
    'context.correction': {'sourceTurnAlias'}, 'context.current_use': {'sourceTurnAlias', 'factKeys'},
    'memory.history_use': {'sessionAlias', 'sourceTurnAlias', 'factKeys'}, 'compaction.fact_retention': {'sourceTurnAlias', 'factKeys'},
    'compaction.continue': {'factKeys'}, 'subagent.success': {'factKeys'}, 'subagent.utility': {'factKeys'},
    'subagent.identity_scope': {'allowedTools', 'regions'}, 'subagent.stop': {'requiredCleanup'}, 'subagent.delegation': {'delegate'},
    'intent.route_exact': {'program'}, 'security.injection': {'forbiddenMarkers', 'forbiddenActions'},
    'security.scope': {'regions'}, 'security.side_effect': {'authorized', 'requiresConfirmation'},
    'export.exact': {'format', 'sourceQueryAlias', 'requiredColumns'},
}
assertions = 0


def check(ok, message):
    global assertions
    assertions += 1
    if not ok:
        raise ValueError(message)


def clean(value):
    if isinstance(value, dict):
        for key, item in value.items():
            check(not re.search(r'hash|sha256|digest|fingerprint', key, re.I), 'Forbidden stored field: ' + key)
            clean(item)
    elif isinstance(value, list):
        for item in value:
            clean(item)
    elif isinstance(value, str):
        check(not re.search(r'[a-f0-9]{64}|@runtime:[^\n]*hash', value, re.I), 'Forbidden stored digest')


def source_text(path):
    with path.open(encoding='utf-8', newline='') as source:
        return source.read()


def safe_integer(value):
    return type(value) is int and 0 <= value <= 9007199254740991


def verify_sources(snapshot, supplementary=False):
    references = snapshot['sourceReferences']
    check(isinstance(references, dict) and bool(references), 'Business source references exist')
    for identity, reference in references.items():
        issue = supplementary and reference['kind'] == 'historical-issue'
        check((reference['kind'] == 'product-spec' or issue) and bool(reference['rationale']), 'Truthful hand-authored source reference: ' + identity)
        relative = Path(reference['path'])
        prefix = 'agent-eval/records/' if issue else 'docs/spec/'
        check(not relative.is_absolute() and '..' not in relative.parts and reference['path'].startswith(prefix), 'Source reference stays in its declared scope')
        path = REPOSITORY / relative
        check(path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(REPOSITORY.resolve()), 'Business reference file exists')
        check(reference['section'] in source_text(path), 'Business reference section exists: ' + identity)
    resources = snapshot['productResources']
    check(len(resources) == 1 and resources[0]['kind'] == 'skill' and resources[0]['id'] == 'query' and resources[0]['version'] == 'v1', 'Use the actual query/v1 resource')
    files = resources[0]['files']
    expected = {'SKILL.md': PRODUCT_INPUTS[0], 'references/facts-and-assumptions.md': PRODUCT_INPUTS[1]}
    check(len(files) == len(expected) and {file['path'] for file in files} == set(expected), 'Both real Skill files are archived once')
    for file in files:
        check(file['bytes'] == len(file['content'].encode('utf-8')), 'Product resource byte length')
        check(file['content'] == source_text(ROOT / expected[file['path']]), 'Archived product resource matches its actual file')


def scope(region):
    return {'浙江': 'synthetic-zj-v1', '河南': 'synthetic-hn-v1'}[region]


def recompute(rows, target):
    def in_region(row):
        return (not target.get('region') or row['region'] == target['region']) and (not target.get('regions') or row['region'] in target['regions'])

    def matches(row):
        fields = ['device', 'name', 'manufacturer', 'category', 'status', 'distributor']
        return in_region(row) and all(not target.get(key) or row[key] == target[key] for key in fields)

    dates = sorted({row['date'] for row in rows if in_region(row)})
    requested = target.get('date', '2026-10-02')
    actual = max((day for day in dates if day <= requested), default=None) if target.get('asOf') else requested if requested in dates else None
    semantic = target['op'] in ['clarify', 'refuse', 'unsupported', 'explain']
    snapshot = [] if semantic else [row for row in rows if row['date'] == actual and matches(row)]
    events = []
    for previous, current in zip(dates, dates[1:]):
        before = {row['device']: row for row in rows if row['date'] == previous}
        after = {row['device']: row for row in rows if row['date'] == current}
        for device in sorted(set(before) | set(after)):
            old, new = before.get(device), after.get(device)
            row = new or old
            if not matches(row) or target.get('start') and current < target['start'] or target.get('endExclusive') and current >= target['endExclusive']:
                continue
            fields = ['price', 'status', 'distributor'] if old and new else ['presence']
            for field in fields:
                old_value = old[field] if old and field != 'presence' else 'present' if old else None
                new_value = new[field] if new and field != 'presence' else 'present' if new else None
                if old_value != new_value:
                    events.append(dict(key=f"{device}@{scope(row['region'])}|{current}|{field if field != 'presence' else 'added' if new else 'missing'}", type='field_changed' if field != 'presence' else 'added' if new else 'missing', old=old_value, new=new_value, device=device, region=row['region'], date=current, field=field, oldPrice=old['price'] if old else None, newPrice=new['price'] if new else None, sourceKeys=[item['key'] for item in [old, new] if item]))
    selected = [event for event in events if target['op'] not in ['price', 'status', 'distributor'] or event['field'] == target['op']]
    if target.get('threshold'):
        threshold = target['threshold']
        def satisfies(event):
            old, new = event['oldPrice'], event['newPrice']
            if event['field'] != 'price' or old is None or new is None or old == 0 or new >= old:
                return False
            decrease, boundary = Decimal(old - new) * 100, Decimal(old) * Decimal(threshold['percent'])
            return decrease > boundary if threshold['operator'] == 'gt' else decrease >= boundary
        selected = [event for event in selected if satisfies(event)]
    changing = target['op'] in ['price', 'status', 'distributor', 'events']
    entity = lambda row: row['device'] + '@' + scope(row['region'])
    keys = sorted({entity(event) for event in selected}) if changing else sorted(entity(row) for row in snapshot)
    numeric = [dict(id=entity(row), value=row['price'], unit='CNY cents') for row in snapshot if row['price'] is not None]
    aggregates = {}
    metric = target.get('metric')
    if metric in ['change_count', 'changed_device_count']:
        groups = {}
        for event in selected:
            row = next(row for row in rows if row['device'] == event['device'] and row['date'] == event['date'])
            groups.setdefault(row[target['group']] if target.get('group') else 'all', []).append(event)
        if not target.get('group'):
            groups.setdefault('all', [])
        aggregates = {key: len(items) if metric == 'change_count' else len({item['device'] for item in items}) for key, items in groups.items()}
    elif metric in ['sum_price', 'mean_price']:
        prices = [Decimal(row['price']) for row in snapshot if row['price'] is not None]
        aggregates = {'all': float(sum(prices)) if metric == 'sum_price' else float(sum(prices) / len(prices)) if prices else None}
    else:
        for row in snapshot:
            key = row[target['group']] if target.get('group') else 'all'
            aggregates[key] = aggregates.get(key, 0) + 1
    trend = []
    if target['op'] == 'trend':
        day, end = date.fromisoformat(target['start']), date.fromisoformat(target['endExclusive'])
        while day < end:
            value = day.isoformat()
            relevant = [event for event in events if event['date'] == value]
            count = len(relevant) if metric == 'change_count' else len({event['device'] for event in relevant}) if metric == 'changed_device_count' else sum(row['date'] == value and matches(row) for row in rows)
            trend.append(dict(date=value, gap=value not in dates, value=count if value in dates else None))
            day += timedelta(days=1)
    used = [row for row in rows if any(row['key'] in event['sourceKeys'] for event in selected)] if changing else snapshot
    if not used:
        used = [row for row in rows if not target.get('region') or row['region'] == target['region']]
    return dict(sets=keys, numeric=numeric, aggregate=[dict(key=key, count=value) for key, value in sorted(aggregates.items())], trend=trend,
                diff=sorted([dict(key=event['key'], type=event['type'], old=event['old'], new=event['new']) for event in selected], key=lambda item: item['key']),
                rows=snapshot, sourceKeys=list(dict.fromkeys(row['key'] for row in used)),
                interpretation=dict(requestedDate=requested, actualDataDate=actual, snapshotMode='as_of' if target.get('asOf') else 'exact_date', region=target.get('region'), scopeKey=scope(target['region']) if target.get('region') else None, isStale=None if actual is None else actual != requested, quantityUnit='events' if metric == 'change_count' else 'identifiers' if metric == 'changed_device_count' else 'records', nullPriceDeviceIds=[entity(row) for row in snapshot if row['price'] is None], ratioUnknown=[event['key'] for event in selected if event['field'] == 'price' and event['oldPrice'] in [None, 0]]))


def verify(snapshot):
    return verify_cases(snapshot, 50, 62, True)


def verify_compiled(snapshot, compiled):
    """Check compiler outputs against authored contracts without importing compiler rules."""
    check(set(compiled) == {case['id'] for case in snapshot['cases']}, 'Compiled cases have exact authored identities')
    for case in snapshot['cases']:
        case_id = case['id']
        definition = case['expected'].get('expectedFacts') or snapshot['gold'][case_id]
        authored = snapshot['gold'][case_id].get('scorerExpectations', {})
        values, checks = compiled[case_id]['values'], compiled[case_id]['checks']
        check(len({item['metricId'] for item in checks}) == len(checks), 'One compiled check per metric')
        for metric in ['tool.recall', 'tool.precision', 'tool.error_rate', 'tool.argument_validity', 'tool.recovery', 'evidence.provenance', 'evidence.freshness', 'efficiency.latency_budget', 'answer.partial_failure']:
            selected = [item for item in checks if item['metricId'] == metric]
            check(bool(selected) == (metric in authored), 'New metric requires independently authored selection')
            if not selected:
                continue
            spec = authored[metric]
            expected = dict(spec)
            if metric == 'tool.recall':
                expected = {'requiredCapabilities': list(dict.fromkeys(case['expected'].get('requiredCapabilities', []) + spec['requiredCapabilities']))}
            elif metric == 'tool.precision':
                expected = {'allowedCapabilities': list(dict.fromkeys(case['expected'].get('requiredCapabilities', []) + case['expected'].get('optionalCapabilities', []) + spec['allowedCapabilities']))}
            elif metric == 'evidence.freshness' and spec['mode'] == 'business_date':
                expected['date'] = spec.get('date', definition['target']['date'])
            elif metric in ['tool.recovery', 'answer.partial_failure']:
                expected['expectedFailureMode'] = spec.get('expectedFailureMode', case['expected'].get('expectedFailureMode'))
            key = metric.replace('.', '_')
            actual = values[key]
            if metric == 'answer.partial_failure':
                check(isinstance(actual.get('rubric'), str) and bool(actual['rubric']), 'Partial failure has its independent semantic rubric')
                actual = {key: actual[key] for key in expected}
            check(actual == expected, 'Compiled expectation matches independent authored contract: ' + case_id + ':' + metric)
            item = selected[0]
            check(item['evidenceKey'] == key and item['goldKey'] == 'values.' + key, 'Compiled metric evidence binding')
            diagnostic = metric == 'tool.error_rate' and 'maxRate' not in spec
            check(item['required'] is (not diagnostic), 'Unbudgeted error rate remains diagnostic')
            if metric == 'tool.error_rate':
                check(item.get('threshold') == spec.get('maxRate'), 'No global error-rate budget is invented')
            check(item['kind'] == ('llm-judge' if metric == 'answer.partial_failure' else 'deterministic'), 'Correct deterministic and semantic separation')


def verify_cases(snapshot, case_count, stage_count, primary):
    clean(snapshot)
    verify_sources(snapshot, supplementary=not primary)
    cases, gold = snapshot['cases'], snapshot['gold']
    check(snapshot['info']['version'] == 1 and snapshot['info']['scoringVersion'] == 'v1', 'Fixed v1')
    check(len(cases) == len({item['id'] for item in cases}) == case_count, 'Expected unique Case count')
    if primary:
        check(bool(snapshot['review'].get('coverageGaps', {}).get('efficiency.latency_budget')), 'Absent independently authored SLO is an explicit coverage gap')
        check(dict(Counter(item['category'] for item in cases)) == CATEGORY_COUNTS, 'Exact 11 Harness category counts')
        check(list(dict.fromkeys(item['category'] for item in cases)) == list(CATEGORY_COUNTS), 'Harness groups retain their declared order')
    check(len(snapshot['smokeIds']) == len(set(snapshot['smokeIds'])) == (10 if primary else 0) and set(snapshot['smokeIds']) <= {item['id'] for item in cases}, 'Declared Smoke refs')
    fixture_catalog = json.loads(snapshot['fixtures']['medclaw-agent-v1.fixtures.json'])
    check(fixture_catalog['version'] == 1, 'Fixture version stays 1')
    rows = list(csv.DictReader(io.StringIO(snapshot['fixtures'][fixture_catalog['source']['ref']])))
    for row in rows:
        row['price'] = None if row['price'] == 'null' else int(Decimal(row['price']))
        row['distributor'] = None if row['distributor'] == 'null' else row['distributor']
    check(len(rows) == len({row['key'] for row in rows}), 'Unique source rows')
    stages = 0
    for case in cases:
        expected = case['expected']
        check(case['source'] == 'hand-authored' and case['evalType'] in ['capability', 'regression'], 'Honest source and purpose')
        check(case['difficulty'] in ['golden', 'difficult', 'long_tail', 'tool_failure', 'regression', 'adversarial'], 'Difficulty tag is valid')
        check(safe_integer(expected['maxToolCalls']), 'Explicit nonnegative safe integer tool budget: ' + case['id'])
        check(type(expected['mustHaveEvidence']) is bool, 'Explicit boolean evidence requirement: ' + case['id'])
        check(case.get('sourceRef') in snapshot['sourceReferences'], 'Business source reference resolves: ' + case['id'])
        check('environment' not in case['input']['workspaceContext'], 'No inert environment placeholder')
        check(bool(case['input']['prompt']) and bool(case['input']['fixture']['ref']) and bool(expected['forbiddenConditions']) and bool(expected['expectedAnswerHint']) and bool(case['scorers']) and isinstance(case['risks'], list), 'Six authoring requirements')
        check(1 <= len(expected['forbiddenConditions']) <= 3 and len(set(expected['forbiddenConditions'])) == len(expected['forbiddenConditions']), 'One to three specific failure conditions')
        check(bool(expected.get('expectedFacts')) != bool(expected.get('goldRef')), 'Truth defined once')
        check(case['input']['fixture']['ref'] in fixture_catalog['profiles'], 'Fixture reference resolves')
        if primary:
            for description in [case['name'], expected['expectedAnswerHint'], *expected['forbiddenConditions']]:
                check(not re.search(r'[\u3400-\u9fff]', description), 'English case descriptions: ' + case['id'])
            prompts = [case['input']['prompt']] + [step['action']['prompt'] for step in case['input'].get('turns', []) if step['action']['action'] == 'send']
            for prompt in prompts:
                for row in rows:
                    for field in ['name', 'manufacturer', 'category', 'region', 'distributor', 'applicant']:
                        if row[field]:
                            prompt = prompt.replace(row[field], '')
                check(not re.search(r'[\u3400-\u9fff]', prompt), 'English user input except source business literals: ' + case['id'])
        definition = expected.get('expectedFacts') or gold[expected['goldRef']]
        metadata = gold[case['id']]
        applicable = set(case['scorers']) | COMMON_SCORERS
        if expected['mustHaveEvidence']:
            applicable.add('evidence.present')
        if definition['target']['op'] == 'current' and 'query.coverage' not in applicable:
            applicable.add('query.facts')
        authoring = snapshot['review']['cases'][case['id']]['authoring']
        budget = authoring['budget']
        check(all(safe_integer(budget[key]) for key in ['necessary', 'verification', 'recovery']) and bool(budget['explanation']), 'Reviewed budget components')
        check(sum(budget[key] for key in ['necessary', 'verification', 'recovery']) == expected['maxToolCalls'], 'Reviewed budget equals the authored limit')
        check(bool(authoring['evidence']) and bool(authoring['harness']), 'Evidence and functional-check rationale')
        check([failure['condition'] for failure in authoring['failures']] == expected['forbiddenConditions'], 'Review binds actual failure conditions')
        check(all(failure['scorers'] and set(failure['scorers']) <= applicable for failure in authoring['failures']), 'Every failure maps to applicable scorers')
        check(set(authoring['harness']) <= applicable and set(case['scorers']) <= set(authoring['harness']), 'Reviewed functional checks are consumed')
        special = metadata.get('scorerExpectations', {})
        check(set(special) <= applicable and set(special) <= set(SPECIAL_FIELDS), 'No unused or unknown functional expectation')
        check(all(set(payload) <= SPECIAL_FIELDS[scorer] and (bool(payload) or scorer in {'tool.argument_validity', 'tool.error_rate'}) for scorer, payload in special.items()), 'Only typed scorer fields are authored')
        check(set(case['scorers']) & set(SPECIAL_FIELDS) <= set(special), 'Selected functional scorers have authored expectations')
        if 'context.necessary_coverage' in special:
            fields = special['context.necessary_coverage']['fields']
            check(bool(fields) and len(set(fields)) == len(fields) and set(fields) <= {'referenceDate', 'selectedDevice', 'selectedRegion'}, 'Known independently authored necessary Context fields')
            check('selectedDevice' not in fields or bool(case['input']['workspaceContext'].get('device')), 'Selected Device is independently specified')
            check('selectedRegion' not in fields or bool(case['input']['workspaceContext'].get('region')), 'Selected region is independently specified')
        if 'context.delivery' in special:
            check(special['context.delivery']['required'] is True, 'Actual request and delivery identity chain is required')
        if 'evidence.coverage' in special:
            keys = special['evidence.coverage']['factKeys']
            check(bool(keys) and len(set(keys)) == len(keys) and set(keys) <= set(definition['facts']), 'Evidence coverage uses independent Gold facts, not an Agent response')
        for scorer in ['tool.recall', 'tool.precision']:
            if scorer in special:
                key = 'requiredCapabilities' if scorer == 'tool.recall' else 'allowedCapabilities'
                check(set(special[scorer]) == {key} and isinstance(special[scorer][key], list) and len(set(special[scorer][key])) == len(special[scorer][key]), 'Explicit unique tool capabilities')
                check(not set(special[scorer][key]) & set(expected.get('forbiddenCapabilities', [])), 'Expected tools do not bypass forbidden capabilities')
        if 'tool.error_rate' in special and 'maxRate' in special['tool.error_rate']:
            value = special['tool.error_rate']['maxRate']
            check(type(value) in [int, float] and 0 <= value <= 1, 'Explicit optional error-rate budget')
        if 'tool.argument_validity' in special:
            check(special['tool.argument_validity'] == {}, 'Argument validity uses actual schema proofs without expected argument facts')
        if 'evidence.provenance' in special:
            check(special['evidence.provenance'] == {'required': True}, 'Actual provenance is required')
        if 'evidence.freshness' in special:
            spec = special['evidence.freshness']
            check(spec['mode'] in ['business_date', 'age'], 'Explicit freshness mode')
            if spec['mode'] == 'business_date':
                check(set(spec) <= {'mode', 'date', 'maxLagDays'} and safe_integer(spec['maxLagDays']), 'Business date tolerance is independently authored')
                check(date.fromisoformat(spec.get('date', definition['target']['date'])).isoformat() == spec.get('date', definition['target']['date']), 'Freshness refers to an explicit target business date')
            else:
                check(set(spec) == {'mode', 'asOf', 'maxAgeMs'} and safe_integer(spec['maxAgeMs']) and datetime.fromisoformat(spec['asOf'].replace('Z', '+00:00')).tzinfo is not None, 'Age freshness has explicit reference instant and budget')
        if 'efficiency.latency_budget' in special:
            check(set(special['efficiency.latency_budget']) == {'maxMs'} and safe_integer(special['efficiency.latency_budget']['maxMs']) and special['efficiency.latency_budget']['maxMs'] > 0, 'Explicit independently authored latency budget')
        if 'tool.recovery' in special:
            spec = special['tool.recovery']
            check(safe_integer(spec['maxRetries']) and bool(spec['allowedTools']) and type(spec['allowStop']) is bool and spec.get('expectedFailureMode') == expected.get('expectedFailureMode') == 'tool_timeout', 'Recovery matches controlled failure and authored retry allowance')
        if 'answer.partial_failure' in special:
            check(type(special['answer.partial_failure']['requireDisclosure']) is bool and expected.get('expectedFailureMode') == 'tool_timeout', 'Partial failure semantic check has actual controlled failure evidence')
            check(not special['answer.partial_failure']['requireDisclosure'] or 'Briefly identify the failure' in case['input']['prompt'], 'Recovered disclosure is explicitly requested by the authored task')
        rubric = metadata.get('rubric', {})
        check(set(rubric) == set(case['scorers']) & SEMANTIC_SCORERS, 'Every applicable semantic scorer has its own rubric')
        for scorer, criteria in rubric.items():
            check(set(criteria) == {'pass', 'partial', 'fail'} and all(isinstance(value, str) and value for value in criteria.values()), 'Three explicit semantic rubric levels: ' + scorer)
            check(not any(re.search(r'[\u3400-\u9fff]', value) for value in criteria.values()), 'English scoring instructions')
        evidence = metadata['evidenceRequirements']
        check(type(evidence['mustCite']) is bool and safe_integer(evidence['minSources']), 'Typed evidence requirements')
        check(set(evidence['sourceKinds']) <= {'synthetic_authored', 'product_resource'}, 'Actual supported source kinds')
        check(set(metadata['expectedSources']) <= {fixture_catalog['source']['id'], 'skill:query@v1'}, 'Stable actual source identities')
        profile = fixture_catalog['profiles'][case['input']['fixture']['ref']]
        aliases = {'turn-1'} | {step['action']['alias'] for step in case['input'].get('turns', []) if step['action']['action'] == 'send'}
        for payload in special.values():
            if 'sourceTurnAlias' in payload:
                check(payload['sourceTurnAlias'] in aliases, 'Functional source turn exists')
        if 'resource.progressive_read' in special:
            reading = special['resource.progressive_read']
            available = {'materials/procurement.csv'} | {file['path'] for file in profile['files']}
            check(set(reading['requiredRefs']) <= available and safe_integer(reading['maxBytes']) and reading['maxBytes'] > 0, 'Actual guide and byte-budget declaration')
        if case['category'] == 'skill':
            check(profile.get('resources') == {'skills': [{'id': 'query', 'version': 'v1'}]}, 'Real Skill is available for both positive and negative cases')
            if case['id'] == 'mc-v1-skill-unrelated-skill':
                check(special['skill.selection']['allowedSkillIds'] == [None] and 'resource.read' not in special, 'Negative Skill case checks avoidance, not absence')
            else:
                check(special['skill.selection']['allowedSkillIds'] == ['query'] and case['input']['prompt'].startswith('/skill:query '), 'Explicit real Skill selection')
                refs = special['resource.read']['requiredRefs']
                check(len(refs) == 2 and {ref['file'] for ref in refs} == {'SKILL.md', 'references/facts-and-assumptions.md'} and all(ref['kind'] == 'skill' and ref['id'] == 'query' and ref['version'] == 'v1' for ref in refs), 'Skill body and reference have actual consumers')
        if expected.get('expectedFailureMode') == 'tool_timeout':
            check(profile.get('controlledToolFault') == 'query-timeout-once' and special['tool.failure_handling']['maxRetries'] == 1 and expected['maxToolCalls'] == 8, 'One actual timeout and bounded retry scenario')
        if expected.get('expectedFailureMode') == 'resource_unavailable':
            check('materials/legacy-price-guide.md' in profile['absentFiles'] and not any(file['path'] == 'materials/legacy-price-guide.md' for file in profile['files']), 'Missing resource is actually absent')
        if 'export.exact' in special:
            check(special['export.exact']['format'] in ['csv', 'json', 'markdown'] and special['export.exact']['sourceQueryAlias'] in {alias + ':query:1' for alias in aliases}, 'Export has a real source-query binding')
        if 'security.side_effect' in special:
            boundary = special['security.side_effect']
            check(not set(boundary.get('requiresConfirmation', [])) & set(expected.get('forbiddenCapabilities', [])), 'Conditional authorization is not a global forbidden capability')
        actual = recompute(rows, definition['target'])
        for field, value in definition['facts'].items():
            check(value == actual[field], f"{case['id']}: {field} mismatch")
        stages += 1
        initial = gold[case['id']].get('initial')
        if initial:
            actual = recompute(rows, initial['target'])
            for field, value in initial['facts'].items():
                check(value == actual[field], f"{case['id']} initial: {field} mismatch")
            stages += 1
        check(case['id'] in snapshot['review']['cases'], 'Central review identity')
    check(next(row['price'] for row in rows if row['key'] == 'ZJ-A|2026-10-02') == 8100, '81 CNY from 8100 cents')
    check(next(row['price'] for row in rows if row['key'] == 'ZJ-B|2026-09-28') == 0, 'Zero stays zero')
    check(next(row['price'] for row in rows if row['key'] == 'ZJ-C|2026-10-02') is None, 'Missing stays null')
    check(not any(row['date'] == '2026-09-30' for row in rows), 'Missing date stays absent')
    check(stages == stage_count, 'Expected independently checked truth stages')
    check(snapshot['review']['qualityRuns'] == 'NOT_RUN' and snapshot['review']['exposure'] == 'developer_visible', 'No fabricated quality run or blind holdout')
    return len(rows), stages


def confined_source(relative, required=True):
    parts = Path(relative)
    check(not parts.is_absolute() and ':' not in relative and '..' not in parts.parts, 'Portable source path')
    current = REPOSITORY
    for part in parts.parts:
        current = current / part
        check(not current.is_symlink(), 'No linked source component')
    check(current.resolve().is_relative_to(REPOSITORY.resolve()), 'Confined source path')
    if required:
        check(current.is_file(), 'Source file exists')
    return current


def verify_origins(snapshot):
    counts = dict(frozen=0, original=0)
    for case_id, origin in snapshot['caseOrigins'].items():
        issue = confined_source('agent-eval/records/' + origin['batchId'] + '/issues.md')
        check(origin['issueId'] in source_text(issue), 'Original Issue exists')
        packet_ref = 'agent-eval/records/' + origin['batchId'] + '/admission-evidence.json'
        check(origin['evidencePacketRef'] == packet_ref, 'Frozen packet belongs to the source batch')
        packet = json.loads(source_text(confined_source(packet_ref)))
        check(packet['batchId'] == origin['batchId'] and bool(packet['capturedBy']) and datetime.fromisoformat(packet['capturedAt'].replace('Z', '+00:00')).tzinfo is not None, 'Actual capture identity and time')
        sources = [source for source in packet['sources'] if source['caseId'] == case_id]
        check(len(sources) == 1 and sources[0] == dict(caseId=case_id, sourceExecutionId=origin['sourceExecutionId'], sourceCaseId=origin['sourceCaseId'], sourceTrialId=origin['sourceTrialId'], evidenceRefs=origin['evidenceRefs']), 'Frozen source association and excerpts match')
        roots = [f"agent-eval/runs/business/{origin['sourceExecutionId']}/evidence/{origin['sourceTrialId']}/",
                 f"agent-eval/records/{origin['batchId']}/reproductions/{origin['sourceExecutionId']}/evidence/{origin['sourceTrialId']}/"]
        check(bool(origin['evidenceRefs']), 'Minimal original evidence exists')
        for ref in origin['evidenceRefs']:
            check(ref['path'] in [root + name for root in roots for name in ['observation.json', 'trial.json']], 'Evidence belongs to original execution and Trial')
            check(ref['pointer'].startswith('/') and not re.search(r'~(?![01])', ref['pointer']), 'Valid JSON pointer')
            check(type(ref['value']) in [str, int, float, bool, type(None)] and (not isinstance(ref['value'], str) or len(ref['value']) <= 2000), 'Only minimal scalar excerpts')
            counts['frozen'] += 1
            path = confined_source(ref['path'], required=False)
            if not path.exists():
                continue
            check(path.is_file(), 'Original source is a file')
            value = json.loads(source_text(path))
            for token in ref['pointer'][1:].split('/'):
                key = token.replace('~1', '/').replace('~0', '~')
                value = value[int(key)] if isinstance(value, list) else value[key]
            check(type(value) is type(ref['value']) and value == ref['value'], 'Frozen fact matches available original evidence')
            trial = json.loads(source_text(confined_source(str(Path(ref['path']).parent / 'trial.json').replace('\\', '/'))))
            observation = json.loads(source_text(confined_source(str(Path(ref['path']).parent / 'observation.json').replace('\\', '/'))))
            check(trial['caseId'] == origin['sourceCaseId'] and trial['trialId'] == origin['sourceTrialId'] and observation['executionId'] == origin['sourceExecutionId'], 'Original Case/Trial/Execution identity')
            counts['original'] += 1
    return counts


def verify_badcase(snapshot, original):
    # Admission retains its historical authored parent while the primary dataset evolves.
    original = snapshot['review'].get('verifiedData') or original
    count, stages = verify_cases(snapshot, 3, 3, False)
    members = ['mc-bc-intent-zh-name', 'mc-v1-intent-resolve', 'mc-v1-intent-clarify-region']
    check(snapshot['info']['id'] == 'medclaw-badcase-v1' and [case['id'] for case in snapshot['cases']] == members, 'First supplementary membership')
    parents = {case['id']: case for case in original['cases']}
    for case in snapshot['cases'][1:]:
        check(case == parents[case['id']] and snapshot['gold'][case['id']] == original['gold'][case['id']], 'Reused Case and Gold remain unchanged')
    chinese = snapshot['cases'][0]
    check(chinese['input']['prompt'] == '查询浙江“合成输注泵 A”在 2026-10-02 的采购价格，并给出数据日期和来源。', 'Canonical Chinese condition')
    check(bool(re.search(r'[\u3400-\u9fff]', chinese['name'])) and chinese['evalType'] == 'capability', 'Chinese name and capability purpose')
    check(snapshot['gold'][chinese['id']] == original['gold']['mc-v1-intent-resolve'], 'Same independently recomputed business truth')
    expected_chinese = json.loads(json.dumps(parents['mc-v1-intent-resolve']))
    expected_chinese.update(id='mc-bc-intent-zh-name', name='中文名称唯一实体的意图查询', evalType='capability', sourceRef='badcase-intent-expression')
    expected_chinese['input']['prompt'] = chinese['input']['prompt']
    expected_chinese['expected']['goldRef'] = chinese['id']
    check(chinese == expected_chinese, 'Only declared Chinese derivation changes')
    for case in snapshot['cases']:
        check(not re.search(r'8100|\b81(?:\.0+)?\b', case['input']['prompt']), 'No reference price in model input')
    origins = snapshot['caseOrigins']
    check(set(origins) == set(members), 'Complete origin identities')
    for case_id, parent, purpose, changes in [
        (members[0], members[1], 'capability', ['id', 'name', 'evalType', 'input.prompt', 'expected.goldRef', 'sourceRef']),
        (members[1], members[1], 'challenge', []),
        (members[2], members[2], 'control', []),
    ]:
        origin = origins[case_id]
        check(origin['issueId'] == 'MC-BC-004' and origin['sourceCaseId'] == parent and origin['derivedFromCaseId'] == parent, 'Actual Issue and parent Case association')
        check(origin['purpose'] == purpose and origin['changes'] == changes, 'Reviewed purpose and derivation declaration')
    verify_origins(snapshot)
    groups = snapshot['lineage']['groups']
    check(len(groups) == 1 and groups[0]['id'] == 'synthetic-procurement-v1' and groups[0]['caseIds'] == members, 'One shared source family')
    check(groups[0]['partition'] == 'developer_visible' and groups[0]['exposure'] == 'developer_visible' and groups[0]['origin'] == 'synthetic_authored' and not groups[0]['parentGroupIds'], 'Honest exposed synthetic provenance')
    check(groups[0]['sourceRefs'] == ['fixtures/procurement.csv'], 'Shared original material')
    return count, stages


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('dataset', nargs='?', choices=['medclaw-agent-v1', 'medclaw-badcase-v1'], default='medclaw-agent-v1')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    catalog = json.loads(source_text(ROOT / 'fixtures/medclaw-agent-v1.fixtures.json'))
    names = {'medclaw-agent-v1.fixtures.json', catalog['source']['ref']}
    for profile in catalog['profiles'].values():
        names.update(file['source'] for file in profile.get('files', []) + profile.get('controllerFiles', []))
        if profile.get('initialConversation'):
            names.add(profile['initialConversation']['source'])
    handoff = json.loads(source_text(ROOT / 'fixtures/procurement-handoff.json'))
    check(handoff['origin'] == 'synthetic_authored' and handoff['license'] == 'CC0-1.0', 'Honest synthetic handoff provenance')
    check(len(handoff['rounds']) == 8 and len({turn['id'] for turn in handoff['rounds']}) == 8, 'Eight unique fixed preparation turns')
    check(all(0 < len(turn['prompt']) <= 18000 for turn in handoff['rounds']), 'Preparation input size leaves room for public attachment metadata')
    check(len({turn['prompt'] for turn in handoff['rounds']}) == 8, 'No duplicate filler turns')
    check(all(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*\.(csv|json|md|txt)', name) for name in names), 'Portable fixture filenames')
    ids = ['medclaw-agent-v1', 'medclaw-badcase-v1'] if args.dataset == 'medclaw-badcase-v1' else ['medclaw-agent-v1']
    paths = [f'datasets/{identity}{suffix}' for identity in ids for suffix in ['.ts', '.gold.ts', '.review.json']] + ['fixtures/' + name for name in sorted(names)] + PRODUCT_INPUTS
    paths += ['evaluation.ts', 'dataset-compiler.ts', 'datasets.ts', 'scoring/registry.ts', 'scoring/general.ts', 'scoring/project-general.ts', 'scoring/project-observation.ts', 'scoring/project-harness.ts', 'scoring/evaluate.ts', '../../packages/contracts/src/business-tools.ts', '../scripts/verify-stage-one.py', '../scripts/export-data.ts', '../scripts/record-data-checks.ts']
    inputs = {name: source_text(ROOT / name) for name in paths}
    exported = subprocess.run(['bun', '--no-env-file', str(SCRIPTS / 'export-data.ts'), args.dataset, '--compiled'], check=True, capture_output=True, text=True, encoding='utf-8')
    payload = json.loads(exported.stdout)
    snapshot = payload['dataset']
    verify_compiled(snapshot, payload['compiled'])
    for reference in snapshot['sourceReferences'].values():
        path = '../../' + reference['path']
        inputs[path] = source_text(ROOT / path)
    if args.dataset == 'medclaw-badcase-v1':
        original = subprocess.run(['bun', '--no-env-file', str(SCRIPTS / 'export-data.ts')], check=True, capture_output=True, text=True, encoding='utf-8')
        for origin in snapshot['caseOrigins'].values():
            paths = ['../../agent-eval/records/' + origin['batchId'] + '/issues.md', '../../' + origin['evidencePacketRef']]
            for path in paths:
                inputs[path] = source_text(ROOT / path)
        count, stages = verify_badcase(snapshot, json.loads(original.stdout))
    else:
        count, stages = verify(snapshot)
    for case in snapshot['cases']:
        if case['category'] in ['memory', 'compaction']:
            check(all(step['action'].get('routing') == 'agent' for step in case['input'].get('turns', []) if step['action']['action'] == 'send'), 'Natural history follow-ups use Agent routing')
        if case['category'] == 'compaction':
            check(case['input']['fixture']['ref'] == 'compaction-history', 'Compaction has registered business handoff initial state')
    check(set(snapshot['fixtures']) == names, 'All archived fixture inputs verified')
    for name in names:
        check(snapshot['fixtures'][name] == inputs['fixtures/' + name], 'Archived fixture equals independent input: ' + name)
    for name, content in inputs.items():
        check(source_text(ROOT / name) == content, 'Inputs changed during verification')
    result = dict(contract='medclaw-data-check-results/v1', status='passed', checker='independent-python-csv-decimal-v1', checkedAt=datetime.now(timezone.utc).isoformat().replace('+00:00','Z'), assertions=assertions, cases=len(snapshot['cases']), stages=stages, sourceRows=count, methods=['typed scorer contract and independently checked compiled expectation bindings (not complete prose failure semantics)', 'independent CSV parsing', 'Decimal boundary and integer-cent recomputation', 'source and six-field audit', 'per-case budget, evidence, functional expectation and rubric mapping', 'actual query/v1 content and business reference sections', 'fixed-v1 and digest-free validation'], inputs=inputs, qualityRuns='NOT_RUN', exposure='developer_visible', unresolvedDataChecks=[])
    if args.dataset == 'medclaw-badcase-v1':
        result['datasetId'] = args.dataset
        result['methods'] += ['frozen scalar source packet; original archive crosscheck when available', 'same-source language/control pairing', 'unchanged reused Case and Gold identities']
    if args.output:
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({key: value for key, value in result.items() if key != 'inputs'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
