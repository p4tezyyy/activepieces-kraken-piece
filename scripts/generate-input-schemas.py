"""Regenerate form metadata from Kraken's published OpenAPI specifications.

Requires Python + PyYAML. Source snapshots are cached in work/ for inspection.
"""
import copy
import html
import json
import pathlib
import re
import urllib.request
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCES = {name: f'https://docs.kraken.com/openapi/{name}-rest.yaml' for name in ['spot', 'futures']}
documents = {}
for family, url in SOURCES.items():
    cache = ROOT / 'work' / f'{family}-openapi.yaml'
    if not cache.exists():
        cache.parent.mkdir(exist_ok=True)
        cache.write_bytes(urllib.request.urlopen(url).read())
    documents[family] = yaml.safe_load(cache.read_text(encoding='utf-8'))

def resolve(value, doc, depth=0):
    if depth > 15:
        return {}
    value = copy.deepcopy(value)
    if '$ref' in value:
        target = doc
        for part in value.pop('$ref')[2:].split('/'):
            target = target[part.replace('~1', '/').replace('~0', '~')]
        value = {**resolve(target, doc, depth + 1), **value}
    for operator in ['allOf', 'oneOf', 'anyOf']:
        if operator in value:
            variants = [resolve(v, doc, depth + 1) for v in value.pop(operator)]
            props = dict(value.get('properties', {}))
            for variant in variants:
                for field, definition in variant.get('properties', {}).items():
                    existing = props.get(field)
                    if existing and operator in ['oneOf', 'anyOf']:
                        a, b = resolve(existing, doc, depth + 1), resolve(definition, doc, depth + 1)
                        if a.get('enum') and b.get('enum'):
                            definition = {**b, 'enum': list(dict.fromkeys(a['enum'] + b['enum']))}
                    props[field] = definition
                for key in ['type', 'items', 'enum']:
                    if key not in value and key in variant:
                        value[key] = variant[key]
            if props:
                value['properties'] = props
            sets = [set(v.get('required', [])) for v in variants]
            required = set.union(*sets) if operator == 'allOf' and sets else set.intersection(*sets) if sets else set()
            value['required'] = list(set(value.get('required', [])) | required)
    return value

def clean(value):
    text = html.unescape(re.sub('<[^>]+>', '', value or ''))
    text = re.sub(r'\[([^]]+)\]\([^)]*\)', r'\1', text)
    return re.sub(r'\s+', ' ', text.replace('`', '')).strip()[:300]

def normalize(schema, doc, required=False, depth=0):
    schema = resolve(schema, doc)
    kind = schema.get('type', 'object' if schema.get('properties') else 'string')
    if isinstance(kind, list):
        kind = next((v for v in kind if v != 'null'), 'string')
    out = {'type': kind, 'required': required}
    for key in ['enum', 'default', 'minimum', 'maximum', 'minItems', 'maxItems', 'format']:
        if key in schema:
            out[key] = schema[key]
    if schema.get('description'):
        out['description'] = clean(schema['description'])
    if schema.get('properties') and depth < 5:
        out['properties'] = {k: normalize(v, doc, k in schema.get('required', []), depth + 1)
            for k, v in schema['properties'].items() if k not in ['nonce', 'otp']}
    if schema.get('items') and depth < 5:
        out['items'] = normalize(schema['items'], doc, depth=depth + 1)
    return out

result = {}
for endpoint in json.loads((ROOT / 'src/endpoints.json').read_text()):
    family, name = endpoint['family'], endpoint['endpoint']
    doc = documents[family]
    path = '/' + ('private/' if endpoint['private'] else 'public/') + name if family == 'spot' else '/' + name
    path_item = doc['paths'].get(path)
    if not path_item:
        raise ValueError(f'Missing official schema for {family}: {name}')
    method = endpoint['method'].lower() if family == 'futures' else ('post' if endpoint['private'] else 'get')
    operation = path_item.get(method) or next(v for k, v in path_item.items() if k in ['get', 'post', 'put', 'delete'])
    fields = {}
    for raw in path_item.get('parameters', []) + operation.get('parameters', []):
        p = resolve(raw, doc)
        if p.get('in') == 'header' or p['name'] in ['nonce', 'otp']:
            continue
        schema = p.get('schema') or next(iter(p.get('content', {}).values()), {}).get('schema', {})
        fields[p['name']] = normalize(schema, doc, p.get('required', False))
        if p.get('description'):
            fields[p['name']]['description'] = clean(p['description'])
    body = resolve(operation.get('requestBody', {}), doc)
    if body:
        content = body.get('content', {})
        schema = content.get('application/json', next(iter(content.values()), {})).get('schema', {})
        fields.update(normalize(schema, doc).get('properties', {}))
    for field in endpoint['fields']:
        if field not in fields:
            # A stale convenience field must never become an undocumented input.
            print(f'Removed undocumented field: {family}/{name}/{field}')
    if endpoint['name'] == 'Validate Order':
        fields.pop('validate', None)
    if name == 'DepositAddresses':
        fields.pop('new', None)
    if name == 'AddOrderBatch':
        fields['orders'].update(minItems=2, maxItems=15)
    if family == 'futures' and name == 'batchorder':
        fields['json']['properties']['batchOrder']['items']['properties']['order'].update(
            required=True, description='Place, edit or cancel an order in this batch.')
    result[family + ':' + endpoint['name']] = {
        'description': clean(operation.get('summary', endpoint['name'])),
        'fields': fields,
    }

target = ROOT / 'src/input-schemas.json'
target.write_text(json.dumps({'sources': SOURCES, 'actions': result}, indent=2) + '\n', encoding='utf-8')
print(f'Generated {len(result)} action schemas, {sum(len(v["fields"]) for v in result.values())} input fields.')
