import ast
import json
import sys


def main():
    request = json.loads(sys.stdin.read() or "{}")
    source = request.get("source") or ""
    function_name = request.get("functionName") or ""
    tree = ast.parse(source)
    tests = []
    fixtures = literal_fixtures(tree)
    for node in tree.body:
        if isinstance(node, ast.FunctionDef):
            extract_body_tests(node.body, function_name, tests, test_bindings(node, fixtures))
        elif isinstance(node, (ast.Assert, ast.With)):
            extract_body_tests([node], function_name, tests, [{}])
    sys.stdout.write(json.dumps({"tests": tests}))


def extract_body_tests(body, function_name, tests, bindings_list):
    for bindings in bindings_list:
        for node in ast.walk(ast.Module(body=body, type_ignores=[])):
            extracted = None
            if isinstance(node, ast.Assert):
                extracted = assertion_to_test(node.test, function_name, len(tests) + 1, bindings)
            elif isinstance(node, ast.With):
                extracted = raises_to_test(node, function_name, len(tests) + 1, bindings)
            if extracted:
                tests.append(extracted)


def assertion_to_test(node, function_name, index, bindings=None):
    bindings = bindings or {}
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
        call = node.operand
        if not is_target_call(call, function_name):
            return None
        try:
            return {
                "name": f"pytest {function_name} case {index}",
                "args": [literal(arg, bindings) for arg in call.args],
                "expect": False,
            }
        except ValueError:
            return None
    if is_target_call(node, function_name):
        try:
            return {
                "name": f"pytest {function_name} case {index}",
                "args": [literal(arg, bindings) for arg in node.args],
                "expect": True,
            }
        except ValueError:
            return None
    if not isinstance(node, ast.Compare) or len(node.ops) != 1 or len(node.comparators) != 1:
        return None
    call = node.left
    if not is_target_call(call, function_name):
        return None
    if not isinstance(node.ops[0], (ast.Eq, ast.Is)):
        return None
    try:
        return {
            "name": f"pytest {function_name} case {index}",
            "args": [literal(arg, bindings) for arg in call.args],
            "expect": literal(node.comparators[0], bindings),
        }
    except ValueError:
        return None


def raises_to_test(node, function_name, index, bindings=None):
    bindings = bindings or {}
    if len(node.items) != 1:
        return None
    context = node.items[0].context_expr
    if not isinstance(context, ast.Call) or call_name(context.func) not in {"raises", "pytest.raises"}:
        return None
    if not context.args:
        return None
    target_call = None
    for statement in node.body:
        if isinstance(statement, ast.Expr) and is_target_call(statement.value, function_name):
            target_call = statement.value
            break
    if not target_call:
        return None
    try:
        return {
            "name": f"pytest {function_name} case {index}",
            "args": [literal(arg, bindings) for arg in target_call.args],
            "expectError": exception_name(context.args[0]),
        }
    except ValueError:
        return None


def is_target_call(node, function_name):
    if not isinstance(node, ast.Call):
        return False
    name = call_name(node.func)
    return name == function_name or name.endswith(f".{function_name}")


def call_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = call_name(node.value)
        return f"{parent}.{node.attr}" if parent else node.attr
    return ""


def exception_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    raise ValueError(f"unsupported exception: {type(node).__name__}")


def parametrize_bindings(function_node):
    rows = [{}]
    for decorator in function_node.decorator_list:
        extracted = extract_parametrize_decorator(decorator)
        if not extracted:
            continue
        names, values = extracted
        next_rows = []
        for existing in rows:
            for row in values:
                if len(row) != len(names):
                    continue
                merged = dict(existing)
                merged.update(dict(zip(names, row)))
                next_rows.append(merged)
        if next_rows:
            rows = next_rows
    return rows


def test_bindings(function_node, fixtures):
    base = {}
    for arg in function_node.args.args:
        if arg.arg in fixtures:
            base[arg.arg] = fixtures[arg.arg]
    rows = parametrize_bindings(function_node)
    return [{**base, **row} for row in rows]


def literal_fixtures(tree):
    fixtures = {}
    for node in tree.body:
        if not isinstance(node, ast.FunctionDef) or not has_fixture_decorator(node):
            continue
        if node.args.args or node.args.vararg or node.args.kwarg or node.args.kwonlyargs:
            continue
        for statement in node.body:
            if isinstance(statement, ast.Return):
                try:
                    fixtures[node.name] = literal(statement.value)
                except ValueError:
                    pass
                break
    return fixtures


def has_fixture_decorator(node):
    for decorator in node.decorator_list:
        if isinstance(decorator, ast.Call):
            name = call_name(decorator.func)
        else:
            name = call_name(decorator)
        if name in {"pytest.fixture", "fixture"}:
            return True
    return False


def extract_parametrize_decorator(node):
    if not isinstance(node, ast.Call) or call_name(node.func) not in {"pytest.mark.parametrize", "mark.parametrize", "parametrize"}:
        return None
    if len(node.args) < 2:
        return None
    try:
        names = parameter_names(node.args[0])
        rows = parameter_rows(node.args[1], len(names))
        return (names, rows) if names and rows else None
    except ValueError:
        return None


def parameter_names(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [name.strip() for name in node.value.replace(",", " ").split() if name.strip()]
    if isinstance(node, (ast.List, ast.Tuple)):
        names = []
        for item in node.elts:
            value = literal(item)
            if isinstance(value, str):
                names.append(value)
        return names
    raise ValueError(f"unsupported parametrize names: {type(node).__name__}")


def parameter_rows(node, width):
    if not isinstance(node, (ast.List, ast.Tuple)):
        raise ValueError(f"unsupported parametrize rows: {type(node).__name__}")
    rows = []
    for item in node.elts:
        if width == 1:
            rows.append([literal(item)])
        elif isinstance(item, (ast.List, ast.Tuple)):
            rows.append([literal(value) for value in item.elts])
        else:
            raise ValueError(f"unsupported parametrize row: {type(item).__name__}")
    return rows


def literal(node, bindings=None):
    bindings = bindings or {}
    if isinstance(node, ast.Name) and node.id in bindings:
        return bindings[node.id]
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        value = literal(node.operand, bindings)
        if isinstance(value, (int, float)):
            return -value
    if isinstance(node, ast.List) or isinstance(node, ast.Tuple):
        return [literal(item, bindings) for item in node.elts]
    if isinstance(node, ast.Dict):
        return {literal(key, bindings): literal(value, bindings) for key, value in zip(node.keys, node.values)}
    raise ValueError(f"unsupported literal: {type(node).__name__}")


if __name__ == "__main__":
    main()
