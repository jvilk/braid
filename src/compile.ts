/// <reference path="ast.ts" />
/// <reference path="visit.ts" />
/// <reference path="util.ts" />

// Basic AST visitor rules implementing a "fold," analogous to a list fold.
// This threads a single function through the whole tree, bottom-up.
type ASTFold <T> = (tree:SyntaxNode, p: T) => T;
function ast_fold_rules <T> (fself: ASTFold<T>): ASTVisit<T, T> {
  return {
    visit_literal(tree: LiteralNode, p: T): T {
      return p;
    },

    visit_seq(tree: SeqNode, p: T): T {
      let p1 = fself(tree.lhs, p);
      let p2 = fself(tree.rhs, p1);
      return p2;
    },

    visit_let(tree: LetNode, p: T): T {
      return fself(tree.expr, p);
    },

    visit_lookup(tree: LookupNode, p: T): T {
      return p;
    },

    visit_binary(tree: BinaryNode, p: T): T {
      let p1 = fself(tree.lhs, p);
      let p2 = fself(tree.rhs, p1);
      return p2;
    },

    visit_quote(tree: QuoteNode, p: T): T {
      return fself(tree.expr, p);
    },

    visit_escape(tree: EscapeNode, p: T): T {
      return fself(tree.expr, p);
    },

    visit_run(tree: RunNode, p: T): T {
      return fself(tree.expr, p);
    },

    visit_fun(tree: FunNode, p: T): T {
      return fself(tree.body, p);
    },

    visit_call(tree: CallNode, p: T): T {
      let p1 = p;
      for (let arg of tree.args) {
        p1 = fself(arg, p1);
      }
      let p2 = fself(tree.fun, p1);
      return p2;
    },

    visit_persist(tree: PersistNode, p: T): T {
      return p;
    },
  };
}

// The main output of def/use analysis: For every lookup node ID, a defining
// node ID and a flag indicating whether the variable is bound (vs. free).
type DefUseTable = [number, boolean][];

// The intermediate data structure for def/use analysis is a *stack of stack
// of maps*. The map assigns a defining node ID for names. We need a stack to
// reflect function scopes, and a stack of *those* to reflect quotes.
type NameMap = { [name: string]: number };
type NameStack = NameMap[][];

// Get the head of the head of a NameStack.
function ns_hd <T> (a: T[][]): T {
  return hd(hd(a));
}

// Like overlay, but works on the top-top of a NameStack.
function ns_overlay <T> (a: T[][]): T[][] {
  let ha = hd(a).slice(0);
  let hm = overlay(hd(ha));
  return cons(cons(hm, tl(ha)), tl(a));
}

// Create an overlay *function* scope in the top stack of a NameStack.
function ns_push_scope(ns: NameStack): NameStack {
  let top_stack = cons(<NameMap> {}, hd(ns));
  return cons(top_stack, tl(ns));
}

// Look up a value from any function scope in the top quote scope. Return the
// value and the index (in *function* scopes) where the value was found.
function ns_lookup (a: NameStack, key: string): [number, number] {
  return stack_lookup(hd(a), key);
}

// Here's the core def/use analysis.
type FindDefUse = ASTFold<[NameStack, DefUseTable]>;
function gen_find_def_use(fself: FindDefUse): FindDefUse {
  let fold_rules = ast_fold_rules(fself);
  let rules = compose_visit(fold_rules, {
    // The "let" case defines a variable in a map to refer to the "let" node.
    visit_let(tree: LetNode, [ns, table]: [NameStack, DefUseTable]):
      [NameStack, DefUseTable]
    {
      let [n1, t1] = fself(tree.expr, [ns, table]);
      let n2 = ns_overlay(n1);
      ns_hd(n2)[tree.ident] = tree.id;
      return [n2, t1];
    },

    // Similarly, "fun" defines variables in the map for its parameters.
    visit_fun(tree: FunNode, [ns, table]: [NameStack, DefUseTable]):
      [NameStack, DefUseTable]
    {
      // Update the top map with the function parameters.
      let n = ns_push_scope(ns);
      for (let param of tree.params) {
        ns_hd(n)[param.name] = param.id;
      }

      // Traverse the body with this new map.
      let [n2, t2] = fself(tree.body, [n, table]);
      // Then continue outside of the `fun` with the old map.
      return [ns, t2];
    },

    // Lookup (i.e., a use) populates the def/use table based on the name map.
    visit_lookup(tree: LookupNode,
      [ns, table]: [NameStack, DefUseTable]):
      [NameStack, DefUseTable]
    {
      let [def_id, scope_index] = ns_lookup(ns, tree.ident);
      if (def_id === undefined) {
        throw "error: variable not in name map";
      }

      // The variable is bound (as opposed to free) if it is found in the
      // topmost function scope.
      let bound = (scope_index === 0);

      let t = table.slice(0);
      t[tree.id] = [def_id, bound];
      return [ns, t];
    },

    // On quote, push an empty name map stack.
    visit_quote(tree: QuoteNode, [ns, table]: [NameStack, DefUseTable]):
      [NameStack, DefUseTable]
    {
      // Traverse inside the quote using a new, empty name map stack.
      let n = cons([<NameMap> {}], ns);
      let [_, t] = fold_rules.visit_quote(tree, [n, table]);
      // Then throw away the name map stack but preserve the updated table.
      return [ns, t];
    },

    // And pop on escape.
    visit_escape(tree: EscapeNode,
      [ns, table]: [NameStack, DefUseTable]):
      [NameStack, DefUseTable]
    {
      // Temporarily pop the current quote's scope.
      let n = tl(ns);
      let [_, t] = fold_rules.visit_escape(tree, [n, table]);
      // Then restore the old scope and return the updated table.
      return [ns, t];
    },
  });

  return function (tree: SyntaxNode,
    [ns, table]: [NameStack, DefUseTable]):
    [NameStack, DefUseTable]
  {
    return ast_visit(rules, tree, [ns, table]);
  };
};

// Build a def/use table for lookups that links them to their corresponding
// "let" or "fun" AST nodes.
let _find_def_use = fix(gen_find_def_use);
function find_def_use(tree: SyntaxNode): DefUseTable {
  let [_, t] = _find_def_use(tree, [[[{}]], []]);
  return t;
}

// A procedure is a lambda-lifted function. It includes the original body of
// the function and the IDs of the parameters and the closed-over free
// variables used in the function.
interface Proc {
  id: number,  // or null for the main proc
  body: ExpressionNode,
  params: number[],
  free: number[],
  bound: number[],
  quote: number,  // or null for outside any quote
};

// Core lambda lifting produces Procs for all the `fun` nodes in the program.
//
// An important detail in our lambda-lifting interface is that the original
// functions and calls are *left in the AST* instead of replaced with special
// closure-creation and closure-invocation operations (as you might expect).
// The Proc table on the side serves as *substitutes* for these nodes, so
// their contents (especially `fun` nodes) are irrelevant even though they
// still exist.
//
// The parameters are:
// - Accumulated free variables.
// - Accumulated bound variables.
// - A stack indicating the current quote ID.
// - The output list of Procs.
type LambdaLift = ASTFold<[number[], number[], number[], Proc[]]>;
function gen_lambda_lift(defuse: DefUseTable): Gen<LambdaLift> {
  return function (fself: LambdaLift): LambdaLift {
    let fold_rules = ast_fold_rules(fself);
    let rules = compose_visit(fold_rules, {
      // Collect the free variables and construct a Proc.
      visit_fun(tree: FunNode,
        [free, bound, qid, procs]: [number[], number[], number[], Proc[]]):
        [number[], number[], number[], Proc[]]
      {
        let [f, b, _, p] = fold_rules.visit_fun(tree, [free, [], qid, procs]);

        // Accumulate the parameter IDs.
        let param_ids: number[] = [];
        for (let param of tree.params) {
          param_ids.push(param.id);
        }

        // Get the top quote ID, or null for the outermost stage.
        let q: number;
        if (qid.length > 0) {
          q = hd(qid);
        } else {
          q = null;
        }

        // Insert the new Proc. Procs are indexed by the ID of the defining
        // `fun` node.
        let proc: Proc = {
          id: tree.id,
          body: tree.body,
          params: param_ids,
          free: f,
          bound: b,
          quote: q,
        };
        let p2 = p.slice(0);
        p2[tree.id] = proc;

        return [free, bound, qid, p2];
      },

      // Add free variables to the free set.
      visit_lookup(tree: LookupNode,
        [free, bound, qid, procs]: [number[], number[], number[], Proc[]]):
        [number[], number[], number[], Proc[]]
      {
        let [defid, is_bound] = defuse[tree.id];

        let f: number[];
        if (!is_bound) {
          f = set_add(free, defid);
        } else {
          f = free;
        }

        return [f, bound, qid, procs];
      },

      // Add bound variables to the bound set.
      visit_let(tree: LetNode,
        [free, bound, qid, procs]: [number[], number[], number[], Proc[]]):
        [number[], number[], number[], Proc[]]
      {
        let [f, b, _, p] = fold_rules.visit_let(tree, [free, bound, qid, procs]);
        let b2 = set_add(b, tree.id);
        return [f, b2, qid, p];
      },

      // Push a quote ID.
      visit_quote(tree: QuoteNode,
        [free, bound, qid, procs]: [number[], number[], number[], Proc[]]):
        [number[], number[], number[], Proc[]]
      {
        let q = cons(tree.id, qid);
        let [f, b, _, p] = fself(tree.expr, [free, bound, q, procs]);
        return [f, b, qid, p];
      },

      // Pop a quote ID.
      visit_escape(tree: EscapeNode,
        [free, bound, qid, procs]: [number[], number[], number[], Proc[]]):
        [number[], number[], number[], Proc[]]
      {
        let q = tl(qid);
        let [f, b, _, p] = fself(tree.expr, [free, bound, q, procs]);
        return [f, b, qid, p];
      },
    });

    return function (tree: SyntaxNode,
      [free, bound, qid, procs]: [number[], number[], number[], Proc[]]):
      [number[], number[], number[], Proc[]]
    {
      return ast_visit(rules, tree, [free, bound, qid, procs]);
    }
  }
}

// A wrapper for lambda lifting also includes the "main" function as a Proc
// with no free variables.
function lambda_lift(tree: SyntaxNode, table: DefUseTable): [Proc[], Proc] {
  let _lambda_lift = fix(gen_lambda_lift(table));
  let [_, bound, __, procs] = _lambda_lift(tree, [[], [], [], []]);
  let main: Proc = {
    id: null,
    body: tree,
    params: [],
    free: [],
    bound: bound,
    quote: null,
  };
  return [procs, main];
}

// A Prog represents a quoted program. It's the quotation analogue of a Proc.
// Progs can have bound variables but not free variables.
interface Prog {
  id: number,
  body: ExpressionNode,
  annotation: string,
  bound: number[],
  persist: ProgEscape[],
  splice: ProgEscape[],
}

interface ProgEscape {
  id: number,
  body: ExpressionNode,
}

// Quote lifting is like lambda lifting, but for quotes.
//
// As with lambda lifting, we don't actually change the AST, but the resulting
// Progs do *supplant* the in-AST quote nodes. The same is true of escape
// nodes, which are replaced by the `persist` and `splice` members of Prog.
//
// Call this pass on the entire program (it is insensitive to lambda lifting).
//
// To lift all the Progs, this threads through two stacks of lists: one for
// bound variables (by id), and one for escape nodes.
type QuoteLift = ASTFold<[number[][], EscapeNode[][], Prog[]]>;
function gen_quote_lift(fself: QuoteLift): QuoteLift {
  let fold_rules = ast_fold_rules(fself);
  let rules = compose_visit(fold_rules, {
    // Create a new Prog for each quote.
    visit_quote(tree: QuoteNode,
      [bound, escs, progs]: [number[][], EscapeNode[][], Prog[]]):
      [number[][], EscapeNode[][], Prog[]]
    {
      let bound_inner = cons([], bound);
      let escs_inner = cons([], escs);
      let [b, e, p] = fold_rules.visit_quote(tree,
          [bound_inner, escs_inner, progs]);

      // Sort out the splices and persists.
      let persists: ProgEscape[] = [];
      let splices: ProgEscape[] = [];
      for (let tree of hd(e)) {
        let esc: ProgEscape = {
          id: tree.id,
          body: tree.expr,
        };
        if (tree.kind === "persist") {
          persists.push(esc);
        } else if (tree.kind === "splice") {
          splices.push(esc);
        }
      }

      // Ad a new Prog to the list of products.
      let p2 = p.slice(0);
      p2[tree.id] = {
        id: tree.id,
        body: tree.expr,
        annotation: tree.annotation,
        bound: hd(b),
        persist: persists,
        splice: splices,
      };

      return [tl(b), tl(e), p2];
    },

    // Add bound variables to the bound set.
    visit_let(tree: LetNode,
      [bound, escs, progs]: [number[][], EscapeNode[][], Prog[]]):
      [number[][], EscapeNode[][], Prog[]]
    {
      let [b, e, p] = fold_rules.visit_let(tree, [bound, escs, progs]);

      // Add a new bound variable to the list at the top of the stack.
      let b2 = cons(set_add(hd(b), tree.id), tl(b));

      return [b2, e, p];
    },

    visit_escape(tree: EscapeNode,
      [bound, escs, progs]: [number[][], EscapeNode[][], Prog[]]):
      [number[][], EscapeNode[][], Prog[]]
    {
      // Pop off the current context when recursing.
      let [b, e, p] = fself(tree.expr, [tl(bound), tl(escs), progs]);

      // Add this node to the current escapes.
      let escs_head = cons(tree, hd(escs));

      return [cons(hd(bound), b), cons(escs_head, e), p];
    },
  });

  return function (tree: SyntaxNode,
    [bound, escs, progs]: [number[][], EscapeNode[][], Prog[]]):
    [number[][], EscapeNode[][], Prog[]]
  {
    return ast_visit(rules, tree, [bound, escs, progs]);
  };
};

let _quote_lift = fix(gen_quote_lift);
function quote_lift(tree: SyntaxNode): Prog[] {
  let [_, __, progs] = _quote_lift(tree, [[[]], [[]], []]);
  return progs;
}

// Given a table of Procs, organize them by their containing Prog ID. Return:
// - A list of unquoted Procs.
// - A table of lists of quoted Procs, indexed by the Prog ID.
function procs_by_prog(procs: Proc[], progs: Prog[]): [Proc[], Proc[][]] {
  let toplevel: Proc[] = [];

  // Initialize the quoted-procs table.
  let quoted: Proc[][] = [];
  for (let prog of progs) {
    if (prog !== undefined) {
      quoted[prog.id] = [];
    }
  }

  // Insert each proc where it goes.
  for (let proc of procs) {
    if (proc !== undefined) {
      if (proc.quote === null) {
        toplevel.push(proc);
      } else {
        quoted[proc.quote].push(proc);
      }
    }
  }

  return [toplevel, quoted];
}

// The mid-level IR structure.
interface CompilerIR {
  // The def/use table.
  defuse: DefUseTable;

  // The lambda-lifted Procs. We have all the Procs except main, indexed by
  // ID, and main separately.
  procs: Proc[];
  main: Proc;

  // The quote-lifted Progs. Again, the Progs are indexed by ID.
  progs: Prog[];

  // Association tables between Progs and their asociated Procs. Also, a list
  // of Procs from the top level---not associated with any quote.
  toplevel_procs: Proc[];
  quoted_procs: Proc[][];
}

// This is the semantic analysis that produces our mid-level IR given an
// elaborated, desugared AST.
function semantically_analyze(tree: SyntaxNode): CompilerIR {
  let table = find_def_use(tree);

  // Lambda lifting and quote lifting.
  let [procs, main] = lambda_lift(tree, table);
  let progs = quote_lift(tree);

  // Prog-to-Proc mapping.
  let [toplevel_procs, quoted_procs] = procs_by_prog(procs, progs);

  return {
    defuse: table,
    procs: procs,
    progs: progs,
    main: main,
    toplevel_procs: toplevel_procs,
    quoted_procs: quoted_procs,
  };
}