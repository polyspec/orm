<?php
declare(strict_types=1);

namespace Polyspec\Orm;

use PhpParser\Node;
use PhpParser\NodeVisitorAbstract;

/**
 * Walks one file of a Scan. A scope maps a variable name to the value it holds: ['cls' => class, 'many' => bool], where many marks a
 * collection of models; a variable bound to something else maps to null and hides an outer binding.
 *
 */
final class ScanVisitor extends NodeVisitorAbstract
{
    /** @var list<array<string, array{cls: string, many: bool}|null>> */
    private array $scopes = [[]];
    /** @var list<int> the indexes of $scopes that a function, method or closure opens; a variable is looked up down to the last one */
    private array $barriers = [0];
    /** @var array<string, array{cls: string, many: bool}> functions with a model return type, by lowercase short name */
    private array $functions = [];
    /** @var \SplObjectStorage<Node, string> closures that receive a model as the first parameter */
    private \SplObjectStorage $given;
    /** @var list<array<string, array{cls: string, many: bool}>> typed properties of the classes being walked */
    private array $properties = [];
    /** The namespace being walked, which a relative class name of a @var tag resolves in. */
    private string $namespace = '';
    /** @var array<string, string> the class imports of the file, lowercase alias => fully qualified name */
    private array $uses = [];

    /**
     * @param array<string, string> $models lowercase fully qualified class name => class name
     * @param array<string, array<string, list<int|null>>> $out
     */
    public function __construct(private readonly array $models, private array &$out)
    {
        $this->given = new \SplObjectStorage();
    }

    public function beforeTraverse(array $nodes): ?array
    {
        $this->hoist($nodes);
        return null;
    }

    /** @param array<Node> $nodes */
    private function hoist(array $nodes): void
    {
        foreach ($nodes as $node) {
            if ($node instanceof Node\Stmt\Function_) {
                $value = $this->typeValue($node->returnType);
                if ($value !== null) {
                    $this->functions[strtolower($node->name->toString())] = $value;
                }
            } elseif ($node instanceof Node\Stmt\Namespace_ || $node instanceof Node\Stmt\If_) {
                $this->hoist($node->stmts);
            }
        }
    }

    /** @return array{cls: string, many: bool}|null the model that a declared type names */
    private function typeValue(?Node $type): ?array
    {
        if ($type instanceof Node\NullableType) {
            return $this->typeValue($type->type);
        }
        if ($type instanceof Node\UnionType) {
            $values = array_values(array_filter(array_map(fn(Node $t): ?array => $this->typeValue($t), $type->types)));
            return count($values) === 1 ? $values[0] : null;
        }
        if ($type instanceof Node\Name) {
            $cls = $this->models[strtolower($type->toString())] ?? null;
            return $cls === null ? null : ['cls' => $cls, 'many' => false];
        }
        return null;
    }

    public function enterNode(Node $node): null
    {
        if ($node instanceof Node\Stmt\Namespace_) {
            $this->namespace = $node->name === null ? '' : $node->name->toString();
            $this->uses = [];
        }
        if ($node instanceof Node\Stmt\Use_ && $node->type === Node\Stmt\Use_::TYPE_NORMAL) {
            foreach ($node->uses as $use) {
                $this->uses[strtolower($use->getAlias()->toString())] = $use->name->toString();
            }
        }
        if ($node instanceof Node\Stmt\Class_ || $node instanceof Node\Stmt\Trait_) {
            $props = [];
            foreach ($node->stmts as $stmt) {
                if ($stmt instanceof Node\Stmt\Property) {
                    $value = $this->typeValue($stmt->type);
                    foreach ($stmt->props as $prop) {
                        if ($value !== null) {
                            $props[$prop->name->toString()] = $value;
                        }
                    }
                } elseif ($stmt instanceof Node\Stmt\ClassMethod && strtolower($stmt->name->toString()) === '__construct') {
                    foreach ($stmt->params as $param) {
                        $value = $this->typeValue($param->type);
                        if ($value !== null && $param->flags !== 0 && $param->var instanceof Node\Expr\Variable && is_string($param->var->name)) {
                            $props[$param->var->name] = $value;
                        }
                    }
                }
            }
            $this->properties[] = $props;
        }
        if ($node instanceof Node\FunctionLike) {
            $arrow = $node instanceof Node\Expr\ArrowFunction;
            $uses = $node instanceof Node\Expr\Closure ? $node->uses : [];
            $inherited = [];
            foreach ($uses as $use) {
                if (is_string($use->var->name)) {
                    $inherited[$use->var->name] = $this->lookup($use->var->name);
                }
            }
            if (!$arrow) {
                $this->barriers[] = count($this->scopes);
            }
            $this->scopes[] = $inherited;
            foreach ($node->getParams() as $i => $param) {
                if (!$param->var instanceof Node\Expr\Variable || !is_string($param->var->name)) {
                    continue;
                }
                $value = $this->typeValue($param->type);
                if ($value === null && $param->type === null && $i === 0 && isset($this->given[$node])) {
                    $value = ['cls' => $this->given[$node], 'many' => false];
                }
                $this->scopes[count($this->scopes) - 1][$param->var->name] = $value;
            }
        }
        if ($node instanceof Node\Stmt\Foreach_) {
            $collection = $this->valueOf($node->expr);
            $element = $collection !== null && $collection['many'] ? ['cls' => $collection['cls'], 'many' => false] : null;
            if ($node->valueVar instanceof Node\Expr\Variable && is_string($node->valueVar->name)) {
                $this->bind($node->valueVar->name, $element);
            }
        }
        if ($node instanceof Node\Expr\MethodCall || $node instanceof Node\Expr\NullsafeMethodCall) {
            $this->call($node);
        }
        return null;
    }

    public function leaveNode(Node $node): null
    {
        if ($node instanceof Node\Stmt\Class_ || $node instanceof Node\Stmt\Trait_) {
            array_pop($this->properties);
        }
        if ($node instanceof Node\FunctionLike) {
            array_pop($this->scopes);
            if (!$node instanceof Node\Expr\ArrowFunction) {
                array_pop($this->barriers);
            }
        }
        if ($node instanceof Node\Expr\Assign && $node->var instanceof Node\Expr\Variable && is_string($node->var->name)) {
            $this->bind($node->var->name, $this->valueOf($node->expr));
        }
        // A `/** @var Model|null $name */` tag on an assignment types its variable: a getter returns mixed, so the tag is how
        // a receiver read through a getter names its model.
        if ($node instanceof Node\Stmt\Expression && $node->expr instanceof Node\Expr\Assign && $node->expr->var instanceof Node\Expr\Variable
            && is_string($node->expr->var->name)) {
            $typed = $this->docValue($node->getDocComment()?->getText() ?? '', $node->expr->var->name);
            if ($typed !== null) {
                $this->bind($node->expr->var->name, $typed);
            }
        }
        return null;
    }

    /** @return array{cls: string, many: bool}|null the model that a `@var` tag of the variable names */
    private function docValue(string $doc, string $var): ?array
    {
        if (preg_match('/@var\s+([^\s]+)\s+\$' . preg_quote($var, '/') . '\b/', $doc, $m) !== 1) {
            return null;
        }
        $values = [];
        foreach (explode('|', $m[1]) as $type) {
            $type = ltrim($type, '?');
            if (strtolower($type) === 'null' || $type === '') {
                continue;
            }
            $many = str_ends_with($type, '[]');
            $type = $many ? substr($type, 0, -2) : $type;
            if (str_starts_with($type, '\\')) {
                $name = substr($type, 1);
            } else {
                $first = strtolower(explode('\\', $type)[0]);
                $name = isset($this->uses[$first]) ? $this->uses[$first] . substr($type, strlen($first)) : ltrim($this->namespace . '\\' . $type, '\\');
            }
            $cls = $this->models[strtolower($name)] ?? null;
            $values[] = $cls === null ? null : ['cls' => $cls, 'many' => $many];
        }
        return count($values) === 1 ? $values[0] : null;
    }

    /** @param array{cls: string, many: bool}|null $value */
    private function bind(string $name, ?array $value): void
    {
        $this->scopes[count($this->scopes) - 1][$name] = $value;
    }

    private function call(Node\Expr\MethodCall|Node\Expr\NullsafeMethodCall $node): void
    {
        if (!$node->name instanceof Node\Identifier) {
            return;
        }
        $receiver = $this->valueOf($node->var);
        if ($receiver === null || $receiver['many']) {
            return;
        }
        $name = $node->name->toString();
        $count = 0;
        foreach ($node->args as $arg) {
            if (!$arg instanceof Node\Arg || $arg->unpack || $arg->name !== null) {
                $count = null;
                break;
            }
            $count++;
        }
        $this->out[$receiver['cls']][$name][] = $count;
        $first = $node->args[0] ?? null;
        if (Scan::modelCallback($name) && $first instanceof Node\Arg && ($first->value instanceof Node\Expr\Closure || $first->value instanceof Node\Expr\ArrowFunction)) {
            $this->given[$first->value] = $receiver['cls'];
        }
    }

    /** @return array{cls: string, many: bool}|null the model, or collection of models, that an expression holds */
    private function valueOf(Node $e): ?array
    {
        if ($e instanceof Node\Expr\Variable) {
            return is_string($e->name) && $e->name !== 'this' ? $this->lookup($e->name) : null;
        }
        if ($e instanceof Node\Expr\New_) {
            return $e->class instanceof Node\Name ? $this->typeValue($e->class) : null;
        }
        if ($e instanceof Node\Expr\Assign) {
            return $this->valueOf($e->expr);
        }
        if ($e instanceof Node\Expr\Clone_) {
            return $this->valueOf($e->expr);
        }
        if ($e instanceof Node\Expr\FuncCall && $e->name instanceof Node\Name) {
            return $this->functions[strtolower($e->name->getLast())] ?? null;
        }
        if ($e instanceof Node\Expr\FuncCall && $e->name instanceof Node\Expr) {
            // A model is invocable: (new C)($db) returns the model, as a collection returns itself.
            return $this->valueOf($e->name);
        }
        if ($e instanceof Node\Expr\PropertyFetch || $e instanceof Node\Expr\NullsafePropertyFetch) {
            if ($e->var instanceof Node\Expr\Variable && $e->var->name === 'this' && $e->name instanceof Node\Identifier && $this->properties !== []) {
                return $this->properties[count($this->properties) - 1][$e->name->toString()] ?? null;
            }
            return null;
        }
        if ($e instanceof Node\Expr\ArrayDimFetch) {
            $collection = $this->valueOf($e->var);
            return $collection !== null && $collection['many'] ? ['cls' => $collection['cls'], 'many' => false] : null;
        }
        if (($e instanceof Node\Expr\MethodCall || $e instanceof Node\Expr\NullsafeMethodCall) && $e->name instanceof Node\Identifier) {
            $receiver = $this->valueOf($e->var);
            if ($receiver === null) {
                return null;
            }
            $name = $e->name->toString();
            if ($receiver['many']) {
                return in_array($name, ['first', 'get'], true) ? ['cls' => $receiver['cls'], 'many' => false] : null;
            }
            if ($name === 'gets' || preg_match('/^getsBy[A-Z]/', $name) === 1) {
                return ['cls' => $receiver['cls'], 'many' => true];
            }
            if ($name === 'get' || preg_match('/^getBy[A-Z]/', $name) === 1) {
                return $receiver;
            }
            if (Scan::terminal($name) || preg_match('/^get[A-Z]/', $name) === 1) {
                return null;
            }
            return $receiver;
        }
        return null;
    }

    /** The binding of a variable in the nearest scope that has one, down to the scope of the enclosing function. */
    private function lookup(string $name): ?array
    {
        for ($i = count($this->scopes) - 1; $i >= $this->barriers[count($this->barriers) - 1]; $i--) {
            if (array_key_exists($name, $this->scopes[$i])) {
                return $this->scopes[$i][$name];
            }
        }
        return null;
    }
}
