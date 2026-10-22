<?php

declare(strict_types=1);

namespace Polyspec\Orm;

use PhpParser\Node;
use PhpParser\NodeVisitorAbstract;

/**
 * Walks one file of a Scan. A scope maps a variable name to the value it holds: ['cls' => class,
 * 'many' => bool], where many marks a collection of models; a variable bound to something else maps to
 * null and hides an outer binding.
 *
 */
final class ScanVisitor extends NodeVisitorAbstract
{
    /** @var list<array<string, array{cls: string, many: bool}|null>> */
    private array $scopes = [[]];
    /**
     * @var list<int> the indexes of $scopes that a function, method or closure opens; a variable is looked
     *     up down to the last one
     */
    private array $barriers = [0];
    /**
     * @var array<string, array{cls: string, many: bool}> functions with a model return type, by lowercase
     *     short name
     */
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
     * The if statements being walked, innermost last. Each holds the scope before its branches ('base'),
     * the scope at the end of each branch that is done ('states') and whether an else branch was entered
     * ('else').
     * @var list<array{base: array<string, array{cls: string, many: bool}|null>,
     *     states: list<array<string, array{cls: string, many: bool}|null>>, else: bool}>
     */
    private array $ifs = [];
    /**
     * @var list<array<string, array{cls: string, many: bool}|array{union: list<array{cls: string, many: bool}>}|null>>
     *     the scope before each loop being walked
     */
    private array $loopBefore = [];

    /** @var list<array<string, ?string>> the declared type of each parameter of each enclosing function, innermost last */
    private array $frames = [];

    /**
     * @param array<string, string> $models lowercase fully qualified class name => class name
     * @param array<string, array<string, list<int|null>>> $out
     * @param array<string, array<string, list<array{call: string, type: ?string}>>> $types per model class, the
     *     declared types of the getters that the calls of new, addColumn and alias name, with the call that declares
     *     each
     */
    public function __construct(
        private readonly array $models,
        private array &$out,
        private array &$sites,
        private array &$types,
    ) {
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
        if (self::functionNode($node)) {
            $this->frames[] = $this->paramTypes($node->params);
        }
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
                } elseif (
                    $stmt instanceof Node\Stmt\ClassMethod
                    && strtolower($stmt->name->toString()) === '__construct'
                ) {
                    foreach ($stmt->params as $param) {
                        $value = $this->typeValue($param->type);
                        if (
                            $value !== null && $param->flags !== 0 && $param->var instanceof Node\Expr\Variable
                            && is_string($param->var->name)
                        ) {
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
        if (
            $node instanceof Node\Stmt\While_ || $node instanceof Node\Stmt\Do_ || $node instanceof Node\Stmt\For_
            || $node instanceof Node\Stmt\Foreach_
        ) {
            // Before the loop runs, the scope before it is kept, and each name it assigns may hold the values
            // of its assignments.
            $this->enterLoop($node);
        }
        if ($node instanceof Node\Stmt\Foreach_) {
            $collection = $this->valueOf($node->expr);
            $element = self::elementOf($collection);
            if ($node->valueVar instanceof Node\Expr\Variable && is_string($node->valueVar->name)) {
                $this->bind($node->valueVar->name, $element);
            } else {
                $this->forget($node->valueVar);
            }
            if ($node->keyVar !== null) {
                $this->forget($node->keyVar);
            }
        }
        if ($node instanceof Node\Expr\MethodCall || $node instanceof Node\Expr\NullsafeMethodCall) {
            $this->call($node);
        }
        if ($node instanceof Node\Stmt\Switch_) {
            $this->ifs[] = ['base' => $this->top(), 'states' => [], 'else' => false, 'started' => false,
                'pending' => false];
        }
        if ($node instanceof Node\Stmt\Case_) {
            $i = count($this->ifs) - 1;
            if ($this->ifs[$i]['started']) {
                // A case after another one starts from the scope of the cases before it, since it may fall
                // through; a case that returns does not.
                if (!$this->ifs[$i]['pending']) {
                    $this->ifs[$i]['states'][] = $this->top();
                    $this->setTop(self::mergeScopes([$this->ifs[$i]['base'], $this->top()]));
                } else {
                    $this->setTop($this->ifs[$i]['base']);
                }
            }
            $this->ifs[$i]['started'] = true;
            $this->ifs[$i]['pending'] = self::exits($node->stmts);
            if ($node->cond === null) {
                $this->ifs[$i]['else'] = true;
            }
        }
        if ($node instanceof Node\Stmt\TryCatch) {
            $this->ifs[] = ['base' => $this->top(), 'states' => [], 'else' => false, 'catch' => false,
                'tryEnd' => null, 'finally' => false, 'pending' => self::exits($node->stmts)];
        }
        if ($node instanceof Node\Stmt\Catch_) {
            // The catch starts from the scope before the try joined with the scope at the end of the try block,
            // since an exception can leave any of its statements.
            $i = count($this->ifs) - 1;
            if (!$this->ifs[$i]['catch']) {
                $this->ifs[$i]['catch'] = true;
                $this->ifs[$i]['tryEnd'] = $this->top();
                if (!$this->ifs[$i]['pending']) {
                    $this->ifs[$i]['states'][] = $this->top();
                }
            } elseif (!$this->ifs[$i]['pending']) {
                $this->ifs[$i]['states'][] = $this->top();
            }
            $this->ifs[$i]['pending'] = self::exits($node->stmts);
            $this->setTop(self::mergeScopes([$this->ifs[$i]['base'], $this->ifs[$i]['tryEnd']]));
        }
        if ($node instanceof Node\Stmt\Finally_) {
            $i = count($this->ifs) - 1;
            if (!$this->ifs[$i]['pending']) {
                $this->ifs[$i]['states'][] = $this->top();
            }
            // The finally block starts from every outcome of the try statement, the ones that return included.
            $this->setTop(self::mergeScopes([...$this->ifs[$i]['states'], $this->ifs[$i]['base']]));
            $this->ifs[$i]['states'] = [];
            $this->ifs[$i]['finally'] = true;
            $this->ifs[$i]['pending'] = false;
        }
        if (
            $node instanceof Node\Stmt\Catch_ && $node->var instanceof Node\Expr\Variable
            && is_string($node->var->name)
        ) {
            $this->bind($node->var->name, null);
        }
        if ($node instanceof Node\Stmt\Static_) {
            foreach ($node->vars as $static) {
                $this->forget($static->var);
            }
        }
        if ($node instanceof Node\Stmt\Global_) {
            foreach ($node->vars as $global) {
                $this->forget($global);
            }
        }
        if ($node instanceof Node\Stmt\If_) {
            $this->ifs[] = ['base' => $this->top(), 'states' => [], 'else' => false,
                'pending' => self::exits($node->stmts)];
        }
        if ($node instanceof Node\Stmt\ElseIf_ || $node instanceof Node\Stmt\Else_) {
            // Each branch starts from the scope before the if; the scope at the end of the branch that is done is kept.
            $i = count($this->ifs) - 1;
            if (!$this->ifs[$i]['pending']) {
                $this->ifs[$i]['states'][] = $this->top();
            }
            $this->ifs[$i]['else'] = $this->ifs[$i]['else'] || $node instanceof Node\Stmt\Else_;
            $this->ifs[$i]['pending'] = self::exits($node->stmts);
            $this->setTop($this->ifs[$i]['base']);
        }
        return null;
    }

    public function leaveNode(Node $node): null
    {
        if (self::functionNode($node)) {
            array_pop($this->frames);
        }
        if ($node instanceof Node\Stmt\Class_ || $node instanceof Node\Stmt\Trait_) {
            array_pop($this->properties);
        }
        if (
            $node instanceof Node\Stmt\While_ || $node instanceof Node\Stmt\Do_ || $node instanceof Node\Stmt\For_
            || $node instanceof Node\Stmt\Foreach_
        ) {
            // A loop may run zero times, so the scope after it joins the scope before it.
            $this->setTop(self::mergeScopes([array_pop($this->loopBefore), $this->top()]));
        }
        if (
            $node instanceof Node\Stmt\If_ || $node instanceof Node\Stmt\Switch_
            || $node instanceof Node\Stmt\TryCatch
        ) {
            $frame = array_pop($this->ifs);
            $states = $frame['states'];
            if ($node instanceof Node\Stmt\TryCatch) {
                if (!$frame['finally'] && !$frame['pending']) {
                    $states[] = $this->top();
                }
            } else {
                // The last branch is open; without an else (or default) the scope before the statement is one of
                // the outcomes.
                if (!$frame['pending'] && ($node instanceof Node\Stmt\If_ || $frame['started'])) {
                    $states[] = $this->top();
                }
                if (!$frame['else']) {
                    $states[] = $frame['base'];
                }
            }
            if ($states !== []) {
                $this->setTop(self::mergeScopes($states));
            }
        }
        if ($node instanceof Node\FunctionLike) {
            array_pop($this->scopes);
            if (!$node instanceof Node\Expr\ArrowFunction) {
                array_pop($this->barriers);
            }
        }
        if (
            $node instanceof Node\Expr\Assign && $node->var instanceof Node\Expr\Variable
            && is_string($node->var->name)
        ) {
            $this->bind($node->var->name, $this->valueOf($node->expr));
        } elseif (
            $node instanceof Node\Expr\Assign
            && ($node->var instanceof Node\Expr\Array_ || $node->var instanceof Node\Expr\List_)
        ) {
            // A destructuring assignment binds each variable to a value the scan does not type.
            $this->forget($node->var);
        } elseif (
            $node instanceof Node\Expr\AssignRef && $node->var instanceof Node\Expr\Variable
            && is_string($node->var->name)
        ) {
            // A reference makes both names one variable, whose class the scan does not follow: both are
            // forgotten.
            $this->bind($node->var->name, null);
            if ($node->expr instanceof Node\Expr\Variable && is_string($node->expr->name)) {
                $this->bind($node->expr->name, null);
            }
        } elseif (
            $node instanceof Node\Expr\AssignOp && $node->var instanceof Node\Expr\Variable
            && is_string($node->var->name)
        ) {
            // A compound or coalescing assignment (??=, .=) does not give the variable a model it can be typed
            // with.
            $this->bind($node->var->name, null);
        }
        // A `/** @var Model|null $name */` tag on an assignment types its variable: a getter returns mixed, so
        // the tag is how a receiver read through a getter names its model.
        if (
            $node instanceof Node\Stmt\Expression && $node->expr instanceof Node\Expr\Assign
            && $node->expr->var instanceof Node\Expr\Variable
            && is_string($node->expr->var->name)
        ) {
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
                $name = isset($this->uses[$first]) ? $this->uses[$first] . substr($type, strlen($first))
                    : ltrim($this->namespace . '\\' . $type, '\\');
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

    /**
     * Unbinds every variable of an assignment target that is not a plain variable, such as a list or a
     * destructuring.
     */
    private function forget(?Node $target): void
    {
        if ($target === null) {
            return;
        }
        foreach ((new \PhpParser\NodeFinder())->findInstanceOf($target, Node\Expr\Variable::class) as $variable) {
            if (is_string($variable->name)) {
                $this->bind($variable->name, null);
            }
        }
    }

    /** @return array<string, array{cls: string, many: bool}|null> the scope of the innermost function or file */
    private function top(): array
    {
        return $this->scopes[count($this->scopes) - 1];
    }

    /** @param array<string, array{cls: string, many: bool}|null> $scope */
    private function setTop(array $scope): void
    {
        $this->scopes[count($this->scopes) - 1] = $scope;
    }

    /** Whether a node is a method call, the link of a chain. */
    private static function isCall(Node $node): bool
    {
        return $node instanceof Node\Expr\MethodCall || $node instanceof Node\Expr\NullsafeMethodCall;
    }

    /** Whether a node is a function whose parameters a frame records. */
    private static function functionNode(Node $node): bool
    {
        return $node instanceof Node\Stmt\Function_ || $node instanceof Node\Stmt\ClassMethod
            || $node instanceof Node\Expr\Closure || $node instanceof Node\Expr\ArrowFunction;
    }

    /**
     * The declared type of each parameter of a function, as written: a name, a nullable name, or null when
     * the parameter
     * has no type or a type that is not a single one (a union, an intersection).
     * @param array<Node\Param> $params
     * @return array<string, ?string>
     */
    private function paramTypes(array $params): array
    {
        $out = [];
        foreach ($params as $param) {
            if ($param->var instanceof Node\Expr\Variable && is_string($param->var->name)) {
                $out[$param->var->name] = self::typeName($param->type);
            }
        }
        return $out;
    }

    /** The declared type of a type node as written, or null when it names no single type. */
    private static function typeName(?Node $type): ?string
    {
        if ($type instanceof Node\NullableType) {
            $inner = self::typeName($type->type);
            return $inner === null ? null : "?$inner";
        }
        if ($type instanceof Node\Identifier || $type instanceof Node\Name) {
            return $type->toString();
        }
        return null;
    }

    /**
     * The PHP type of the value of an argument: a literal takes its own type (int, float, string, bool, null), and a
     * variable takes the declared type of its parameter in the innermost function; any other expression has no type
     * that the scan declares, so the result is null.
     */
    private function valueType(Node $value): ?string
    {
        if ($value instanceof Node\Scalar\LNumber) {
            return 'int';
        }
        if ($value instanceof Node\Scalar\DNumber) {
            return 'float';
        }
        if ($value instanceof Node\Scalar\String_) {
            return 'string';
        }
        if ($value instanceof Node\Expr\ConstFetch) {
            return match (strtolower($value->name->toString())) {
                'true', 'false' => 'bool',
                'null' => 'null',
                default => null,
            };
        }
        if ($value instanceof Node\Expr\Variable && is_string($value->name) && $this->frames !== []) {
            return end($this->frames)[$value->name] ?? null;
        }
        return null;
    }

    /**
     * Records the declared types of the getters that a call names. new<Attr>(value) declares get<Attr> with the type of
     * the value; addColumn<Name>(fn): T declares get<Name> with the return type T; and a get or gets that ends a chain
     * with alias<Name> declares get<Name> with the chain's result, ?Model for get and list<Model> for gets. A call
     * without a type is recorded with a null type, which the generator refuses.
     */
    private function declaredTypes(
        Node\Expr\MethodCall|Node\Expr\NullsafeMethodCall $node,
        string $name,
        array $receivers,
        ?int $count,
    ): void {
        $classes = array_values(array_unique(array_map(static fn(array $r): string => $r['cls'], $receivers)));
        if ($classes === []) {
            return;
        }
        if (str_starts_with($name, 'new') && strlen($name) > 3 && $count === 1 && $node->args[0] instanceof Node\Arg) {
            $type = $this->valueType($node->args[0]->value);
            foreach ($classes as $cls) {
                $this->types[$cls]['get' . substr($name, 3)][] = ['call' => $name, 'type' => $type];
            }
        }
        $oneArg = $count === 1 && $node->args[0] instanceof Node\Arg;
        if (str_starts_with($name, 'addColumn') && strlen($name) > 9 && $oneArg) {
            $rest = substr($name, 9);
            $at = strpos($rest, 'Alias');
            $key = $at !== false && $at > 0 && strlen($rest) > $at + 5 ? substr($rest, $at + 5) : $rest;
            $fn = $node->args[0]->value;
            $closure = $fn instanceof Node\Expr\Closure || $fn instanceof Node\Expr\ArrowFunction;
            $type = $closure ? self::typeName($fn->returnType) : null;
            foreach ($classes as $cls) {
                $this->types[$cls]['get' . $key][] = ['call' => $name, 'type' => $type];
            }
        }
        if (($name === 'get' || $name === 'gets') && count($classes) === 1) {
            $this->recordAliases($node->var, $name, $classes[0], $classes[0]);
        }
    }

    /**
     * Records the declared type of each alias in a chain that ends with the get or gets $terminal of the entity
     * $entity.
     * An alias of the chain names a result of the entity: its getter belongs to the entity and has the entity's model,
     * ?Model for get and list<Model> for gets. An alias inside a relation argument names the result of that relation,
     * which belongs to the class that owns the relation, and has the model of the argument's own chain. $entity is null
     * for such an argument, whose alias takes the entity of its own chain.
     */
    private function recordAliases(Node $chain, string $terminal, string $owner, ?string $entity): void
    {
        for ($cur = $chain; self::isCall($cur); $cur = $cur->var) {
            $name = $cur->name instanceof Node\Identifier ? $cur->name->toString() : '';
            if (str_starts_with($name, 'alias') && strlen($name) > 5) {
                $model = $entity ?? (($this->valueOf($cur->var)['cls'] ?? null));
                if ($model !== null) {
                    $type = $terminal === 'gets' ? "list<$model>" : "?$model";
                    $this->types[$owner]['get' . substr($name, 5)][] = ['call' => $name, 'type' => $type];
                }
            }
            if (strtolower($name) === 'relation') {
                $relationOwner = $this->valueOf($cur->var)['cls'] ?? null;
                foreach ($cur->args as $arg) {
                    if ($relationOwner !== null && $arg instanceof Node\Arg) {
                        $this->recordAliases($arg->value, $terminal, $relationOwner, null);
                    }
                }
            }
        }
    }

    private function call(Node\Expr\MethodCall|Node\Expr\NullsafeMethodCall $node): void
    {
        if (!$node->name instanceof Node\Identifier) {
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
        // A name that may hold several models gets the call on each of them.
        $receivers = array_values(array_filter(
            self::members($this->valueOf($node->var)),
            static fn(array $m): bool => !$m['many']
        ));
        foreach ($receivers as $receiver) {
            $this->out[$receiver['cls']][$name][] = $count;
        }
        $this->declaredTypes($node, $name, $receivers, $count);
        if ($receivers !== []) {
            $this->sites[] = ['name' => $name, 'classes' => array_values(array_unique(array_map(
                static fn(array $r): string => $r['cls'],
                $receivers
            ))), 'count' => $count];
        }
        $first = $node->args[0] ?? null;
        if (
            count($receivers) === 1 && Scan::modelCallback($name) && $first instanceof Node\Arg
            && ($first->value instanceof Node\Expr\Closure || $first->value instanceof Node\Expr\ArrowFunction)
        ) {
            $this->given[$first->value] = $receivers[0]['cls'];
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
        // A conditional or a null coalescing holds either operand, as the checker types it: the union of both
        // values (DSL-151).
        if ($e instanceof Node\Expr\Ternary) {
            return self::unionOf([$this->valueOf($e->if ?? $e->cond), $this->valueOf($e->else)]);
        }
        if ($e instanceof Node\Expr\BinaryOp\Coalesce) {
            return self::unionOf([$this->valueOf($e->left), $this->valueOf($e->right)]);
        }
        if ($e instanceof Node\Expr\ConstFetch && strtolower($e->name->toString()) === 'null') {
            return self::nothing();
        }
        if ($e instanceof Node\Expr\FuncCall && $e->name instanceof Node\Name) {
            return $this->functions[strtolower($e->name->getLast())] ?? null;
        }
        if ($e instanceof Node\Expr\FuncCall && $e->name instanceof Node\Expr) {
            // A model is invocable: (new C)($db) returns the model, as a collection returns itself.
            return $this->valueOf($e->name);
        }
        if ($e instanceof Node\Expr\PropertyFetch || $e instanceof Node\Expr\NullsafePropertyFetch) {
            if (
                $e->var instanceof Node\Expr\Variable && $e->var->name === 'this'
                && $e->name instanceof Node\Identifier && $this->properties !== []
            ) {
                return $this->properties[count($this->properties) - 1][$e->name->toString()] ?? null;
            }
            return null;
        }
        if ($e instanceof Node\Expr\ArrayDimFetch) {
            return self::elementOf($this->valueOf($e->var));
        }
        if (
            ($e instanceof Node\Expr\MethodCall || $e instanceof Node\Expr\NullsafeMethodCall)
            && $e->name instanceof Node\Identifier
        ) {
            $receiver = $this->valueOf($e->var);
            if ($receiver === null) {
                return null;
            }
            $name = $e->name->toString();
            return self::unionOf(array_map(
                static fn(array $m): ?array => self::callValue($m, $name),
                self::members($receiver)
            ));
        }
        return null;
    }

    /** The value of a method call on one model or collection of models.
     * @param array{cls: string, many: bool} $receiver */
    private static function callValue(array $receiver, string $name): ?array
    {
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

    /** The model that a variable of a collection holds in each element. */
    private static function elementOf(?array $collection): ?array
    {
        if ($collection === null) {
            return null;
        }
        return self::unionOf(array_map(
            static fn(array $m): ?array => $m['many'] ? ['cls' => $m['cls'], 'many' => false] : null,
            self::members($collection)
        ));
    }

    /**
     * The models of a value: a single model or collection, or each member of a union.
     * @return list<array{cls: string, many: bool}>
     */
    private static function members(?array $value): array
    {
        if ($value === null) {
            return [];
        }
        return $value['union'] ?? [$value];
    }

    /**
     * The value that may hold any of the values: null when one of them is unknown, the value itself when
     * they agree, and a union of their models otherwise.
     * @param list<array{cls: string, many: bool}|null> $values
     * @return array{cls: string, many: bool}|array{union: list<array{cls: string, many: bool}>}|null
     */
    private static function unionOf(array $values): ?array
    {
        $all = [];
        $known = false;
        foreach ($values as $value) {
            if ($value === null) {
                return null;
            }
            foreach (self::members($value) as $member) {
                $all[$member['cls'] . ($member['many'] ? '[]' : '')] = $member;
            }
            $known = $known || ($value['union'] ?? null) !== [];
        }
        if ($all === []) {
            return $values !== [] && !$known ? self::nothing() : null;
        }
        return count($all) === 1 ? array_values($all)[0] : ['union' => array_values($all)];
    }

    /**
     * The scope after branches that each end in one of the given scopes: a name holds the union of its
     * values in them.
     * @param list<array<string, array{cls: string, many: bool}|array{union: list<array{cls: string,
     *     many: bool}>}|null>>
     *     $states
     * @return array<string, array{cls: string, many: bool}|array{union: list<array{cls: string, many: bool}>}|null>
     */
    private static function mergeScopes(array $states): array
    {
        $names = [];
        foreach ($states as $state) {
            foreach (array_keys($state) as $name) {
                $names[$name] = true;
            }
        }
        $merged = [];
        foreach (array_keys($names) as $name) {
            // A state that does not bind the name yet contributes nothing: the name has no value there.
            $values = [];
            foreach ($states as $state) {
                if (array_key_exists($name, $state)) {
                    $values[] = $state[$name];
                }
            }
            $merged[$name] = self::unionOf($values);
        }
        return $merged;
    }

    /**
     * Before a loop runs, a name that the loop assigns may hold what it held before the loop or what its
     * assignments give it, since a later iteration sees the assignments of an earlier one. A reference in
     * the loop makes both of its names unknown.
     */
    private function enterLoop(Node $loop): void
    {
        $this->loopBefore[] = $this->top();
        $values = [];
        $assigns = (new \PhpParser\NodeFinder())->find($loop, static fn(Node $n): bool =>
            $n instanceof Node\Expr\Assign || $n instanceof Node\Expr\AssignRef || $n instanceof Node\Expr\AssignOp);
        foreach ($assigns as $assign) {
            $value = $assign instanceof Node\Expr\Assign ? $this->valueOf($assign->expr) : null;
            if ($assign->var instanceof Node\Expr\Variable && is_string($assign->var->name)) {
                $values[$assign->var->name][] = $value;
            } elseif ($assign->var instanceof Node\Expr\Array_ || $assign->var instanceof Node\Expr\List_) {
                $variables = (new \PhpParser\NodeFinder())->findInstanceOf($assign->var, Node\Expr\Variable::class);
                foreach ($variables as $variable) {
                    if (is_string($variable->name)) {
                        $values[$variable->name][] = null;
                    }
                }
            }
            if (
                $assign instanceof Node\Expr\AssignRef && $assign->expr instanceof Node\Expr\Variable
                && is_string($assign->expr->name)
            ) {
                $values[$assign->expr->name][] = null;
            }
        }
        foreach ($values as $name => $candidates) {
            $before = array_key_exists((string) $name, $this->top()) ? [$this->top()[(string) $name]] : [];
            $this->bind((string) $name, self::unionOf([...$before, ...$candidates]));
        }
    }

    /**
     * Whether a block ends in return or throw, so that the scope after it is not reached from its end.
     *
     * @param array<Node> $stmts
     */
    private static function exits(array $stmts): bool
    {
        $last = $stmts === [] ? null : $stmts[array_key_last($stmts)];
        return $last instanceof Node\Stmt\Return_ || $last instanceof Node\Expr\Throw_
            || ($last instanceof Node\Stmt\Expression && $last->expr instanceof Node\Expr\Throw_);
    }

    /** The value of null: a union of no model, which contributes nothing. */
    private static function nothing(): array
    {
        return ['union' => []];
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
