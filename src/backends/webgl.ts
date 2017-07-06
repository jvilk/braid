import { CompilerIR, Prog, Variant } from '../compile/ir';
import * as js from './js';
import * as glsl from './glsl';
import {
  Glue, emit_glue, vtx_expr, render_expr, ProgKind, prog_kind,
  FLOAT4X4, FLOAT3X3, FLOAT4, SHADER_ANNOTATION, TEXTURE, FLOAT3, FLOAT2
} from './gl';
import { progsym, paren, variant_suffix } from './emitutil';
import { Type, PrimitiveType, FLOAT, INT } from '../type';
import { Emitter, emit, emit_main } from './emitter';
import { ASTVisit, ast_visit, compose_visit } from '../visit';
import { assign } from '../util';
import * as ast from '../ast';
import { getFunc } from './fun';

// Run-time functions invoked by generated code. These could eventually be
// moved to the `glrt` library.
export const RUNTIME = `
// Shader management.
function compile_glsl(gl, type, src) {
  var shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    var errLog = gl.getShaderInfoLog(shader);
    console.error("error: compiling shader:", errLog);
  }
  return shader;
}

function get_shader(gl, vertex_source, fragment_source) {
  var vert = compile_glsl(gl, gl.VERTEX_SHADER, vertex_source);
  var frag = compile_glsl(gl, gl.FRAGMENT_SHADER, fragment_source);
  var program = gl.createProgram();
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    var errLog = gl.getProgramInfoLog(program);
    console.error("error linking program:", errLog);
  }
  return program;
}

// WebGL equivalents of GLSL functions.
// Create vec3 using vec4
function vec3fromvec4(v4) {
  var out = vec3.create();
  out[0] = v4[0] || 0.0;
  out[1] = v4[1] || 0.0;
  out[2] = v4[2] || 0.0;
  return out;
}

// Create vec4 using vec3
function vec4fromvec3(v3, x) {
  var out = vec4.create();
  out[0] = v3[0] || 0.0;
  out[1] = v3[1] || 0.0;
  out[2] = v3[2] || 0.0;
  out[3] = x || 0.0; 
  return out;
}

// vector element-wise absolute value
function vecAbs(v) {
  var out;
  if (v.length === 2) {
    out = vec2.create();
  } else if (v.length === 3) {
    out = vec3.create();
  } else {
    out = vec4.create();
  }

  for (var i = 0; i < v.length; i++) {
    out[i] = Math.abs(v[i]);
  }
}

// normalize a scalar
// s > 0: s = 1
// s = 0: s = 0
// s < 0: s = -1
function normalizeScalar(s) {
  var out;
  if (s > 0) {
    out = 1;
  } else if (s < 0) {
    out = -1;
  } else {
    out = 0;
  }
  return out;
}

// mat3 element-wise division
function mat3div(a, b) {
  var out = mat3.create();
  out[0] = a[0]/b[0];
  out[1] = a[1]/b[1];
  out[2] = a[2]/b[2];
  out[3] = a[3]/b[3];
  out[4] = a[4]/b[4];
  out[5] = a[5]/b[5];
  out[6] = a[6]/b[6];
  out[7] = a[7]/b[7];
  out[8] = a[8]/b[8];
  return out;
}

// mat3 element-wise division
function mat4div(a, b) {
  var out = mat4.create();
  out[0] = a[0]/b[0];
  out[1] = a[1]/b[1];
  out[2] = a[2]/b[2];
  out[3] = a[3]/b[3];
  out[4] = a[4]/b[4];
  out[5] = a[5]/b[5];
  out[6] = a[6]/b[6];
  out[7] = a[7]/b[7];
  out[8] = a[8]/b[8];
  out[9] = a[9]/b[9];
  out[10] = a[10]/b[10];
  out[11] = a[11]/b[11];
  out[12] = a[12]/b[12];
  out[13] = a[13]/b[13];
  out[14] = a[14]/b[14];
  out[15] = a[15]/b[15];
  return out;
}

// mat3 element-wise inverse
function mat3inverse(a) {
  var one = mat3.fromValues(1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0);
  return mat3div(one, a);
}

// mat4 element-wise inverse
function mat4inverse(a) {
  var one = mat4.fromValues(1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0);
  return mat4div(one, a);
}
`.trim();

/**
 * The WebGL functions for binding uniforms.
 */
const GL_UNIFORM_FUNCTIONS: { [_: string]: string } = {
  "Int": "uniform1i",
  "Int3": "uniform3iv",
  "Int4": "uniform4iv",
  "Float": "uniform1f",
  "Float3": "uniform3fv",
  "Float4": "uniform4fv",
  "Float3x3": "uniformMatrix3fv",
  "Float4x4": "uniformMatrix4fv",
};

/**
 * The WebGL `vertexAttribPointer` arguments for binding attributes. This
 * consists of the dimension and the primitive type.
 */
const GL_ATTRIBUTE_TYPES: { [_: string]: [string, string] } = {
  "Float2": ["2", "gl.FLOAT"],
  "Float3": ["3", "gl.FLOAT"],
};

// Get a JavaScript variable name for a compiled shader program. Uses the ID
// of the outermost (vertex) shader Prog.
function shadersym(progid: number) {
  return "s" + progid;
}

// Get a JavaScript variable name to hold a shader location. Uses the ID of
// the corresponding escape expression inside the shader, or the defining
// variable ID for free variables. Also needs the ID of the quote.
function locsym(scopeid: number, escid: number) {
  return "s" + scopeid + "l" + escid;
}

function get_prog_pair(ir: CompilerIR, progid: number) {
  let vertex_prog = ir.progs[progid];

  // Get the fragment program.
  if (vertex_prog.quote_children.length > 1 ||
    vertex_prog.quote_children.length < 1) {
    throw "error: vertex quote must have exactly one fragment quote";
  }
  let fragment_prog = ir.progs[vertex_prog.quote_children[0]];

  return [vertex_prog, fragment_prog];
}

// Emit the JavaScript variable declaration for a *location value* pointing to
// a shader variable. The `scopeid` is the ID of the quote for the shader
// where the variable is located.
function emit_loc_var(scopeid: number, attribute: boolean, varname: string,
  varid: number, variant: Variant | null): string {
  let func = attribute ? "getAttribLocation" : "getUniformLocation";
  let shader = shadersym(scopeid) + variant_suffix(variant);
  return js.emit_var(
    locsym(scopeid, varid) + variant_suffix(variant),
    `gl.${func}(${shader}, ${js.emit_string(varname)})`
  );
}

/**
 * Emit an expression that gets the code string for a shader. This takes care
 * of splicing the code, if necessary.
 *
 * This doesn't quite work yet because we always set up shaders at startup
 * time, not in the context of normal execution.
 */
function emit_shader_code_ref(emitter: Emitter, prog: Prog, variant: Variant | null) {
  let code_expr = progsym(prog.id!) + variant_suffix(variant);
  for (let esc of prog.owned_splice) {
    let esc_expr = emit(emitter, esc.body);
    code_expr += `.replace('__SPLICE_${esc.id}__', ${esc_expr})`;
  }
  return code_expr;
}

// Emit the setup declarations for a shader program. Takes the ID of a vertex
// (top-level) shader program.
function emit_shader_setup(emitter: Emitter, progid: number,
  variant: Variant | null): string {
  let [vertex_prog, fragment_prog] = get_prog_pair(emitter.ir, progid);

  // Compile and link the shader program.
  let vtx_code = emit_shader_code_ref(emitter, vertex_prog, variant);
  let frag_code = emit_shader_code_ref(emitter, fragment_prog, variant);
  let name = shadersym(vertex_prog.id!) + variant_suffix(variant);
  let out = js.emit_var(
    name,
    `get_shader(gl, ${vtx_code}, ${frag_code})`
  ) + "\n";

  // Get the variable locations, for both explicit persists and for free
  // variables.
  let glue = emit_glue(emitter, vertex_prog.id!);
  for (let g of glue) {
    out += emit_loc_var(vertex_prog.id!, g.attribute, g.name, g.id,
      variant) + "\n";
  }

  return out;
}

// Emit a single WebGL binding call for a uniform or attribute. Takes the
// value to bind as a pre-compiled JavaScript string. You also provide the ID
// of the value being sent and the ID of the variable in the shader.
function emit_param_binding(scopeid: number, type: Type, varid: number,
  value: string, attribute: boolean, texture_index: number | undefined,
  variant: Variant | null): string {
  if (!attribute) {
    if (type === TEXTURE) {
      // Bind a texture sampler.
      if (texture_index === undefined) {
        throw "missing texture index";
      }
      let out = `gl.activeTexture(gl.TEXTURE0 + ${texture_index}),\n`;
      out += `gl.bindTexture(gl.TEXTURE_2D, ${value}),\n`;
      let locname = locsym(scopeid, varid) + variant_suffix(variant);
      out += `gl.uniform1i(${locname}, ${texture_index})`;
      return out;

    } else if (type instanceof PrimitiveType) {
      // Ordinary uniform.
      let fname = GL_UNIFORM_FUNCTIONS[type.name];
      if (fname === undefined) {
        throw "error: unsupported uniform type " + type.name;
      }

      // Construct the call to gl.uniformX.
      let is_matrix = fname.indexOf("Matrix") !== -1;
      let locname = locsym(scopeid, varid) + variant_suffix(variant);
      let out = `gl.${fname}(${locname}`;
      if (is_matrix) {
        // Transpose parameter.
        out += ", false";
      }
      out += `, ${paren(value)})`;
      return out;

    } else {
      throw "error: uniforms must be primitive types";
    }

    // Array types are bound as attributes.
  } else {
    if (type instanceof PrimitiveType) {
      // The value is a WebGL buffer object.
      let buf_expr = paren(value);

      // Location handle.
      let loc_expr = locsym(scopeid, varid) + variant_suffix(variant);

      // Choose the `vertexAttribPointer` arguments based on the type.
      let pair = GL_ATTRIBUTE_TYPES[type.name];
      if (!pair) {
        throw `error: unknown attribute type ${type.name}`;
      }
      let [dims, eltype] = pair;

      // Bind the attribute.
      return [
        `gl.bindBuffer(gl.ARRAY_BUFFER, ${buf_expr}),\n`,
        `gl.vertexAttribPointer(${loc_expr}, ${dims}, ${eltype}, `,
        `false, 0, 0),\n`,
        `gl.enableVertexAttribArray(${loc_expr})`
      ].join('');
    } else {
      throw "error: attributes must be primitive types";
    }
  }
}

/**
 * Emit the JavaScript code to bind a shader (i.e., to tell WebGL to use the
 * shader). This includes both the `useProgram` call and the `bindX` calls to
 * set up the uniforms and attributes.
 */
function emit_shader_binding_variant(emitter: Emitter,
  progid: number, variant: Variant | null) {
  let [vertex_prog, fragment_prog] = get_prog_pair(emitter.ir, progid);

  // Bind the shader program.
  let shader_name = shadersym(vertex_prog.id!) + variant_suffix(variant);
  let out = `gl.useProgram(${shader_name})`;

  // Emit and bind the uniforms and attributes.
  let subemitter = assign({}, emitter);
  if (!subemitter.variant) {
    subemitter.variant = variant;
  }
  let glue = emit_glue(subemitter, progid);
  for (let g of glue) {
    let value: string;
    if (g.value_name) {
      value = g.value_name;
    } else {
      value = paren(emit(subemitter, g.value_expr!));
    }
    out += ",\n" + emit_param_binding(vertex_prog.id!, g.type, g.id, value,
      g.attribute, g.texture_index, variant);
  }

  return out;
}

/**
 * Like `emit_shader_binding_variant`, but can also emit a `switch` to select
 * the appropriate variant if the shader is pre-spliced.
 */
function emit_shader_binding(emitter: Emitter, progid: number) {
  // Check whether this shader has variants.
  let variants = emitter.ir.presplice_variants[progid];
  if (variants === null) {
    // No variants.
    return emit_shader_binding_variant(emitter, progid, null);
  } else {
    // Variants exist. Emit the selector.
    return js.emit_variant_selector(
      emitter, emitter.ir.progs[progid], variants,
      (variant) => {
        return emit_shader_binding_variant(emitter, progid, variant);
      }
    );
  }
}

// Extend the JavaScript compiler with some WebGL specifics.
let compile_rules: ASTVisit<Emitter, string> =
  compose_visit(js.compile_rules, {
    // Compile calls to our intrinsics for binding shaders.
    visit_call(tree: ast.CallNode, emitter: Emitter): string {
      // Check for the intrinsic that indicates a shader invocation.
      if (vtx_expr(tree)) {
        // For the moment, we require a literal quote so we can statically
        // emit the bindings.
        if (tree.args[0].tag === "quote") {
          let quote = tree.args[0] as ast.QuoteNode;
          return emit_shader_binding(emitter, quote.id!);
        } else {
          throw "dynamic `vtx` calls unimplemented";
        }

        // And our intrinsic for indicating the rendering stage.
      } else if (render_expr(tree)) {
        // Pass through the code argument.
        return emit(emitter, tree.args[0]);
      } else if (tree.fun.tag === "lookup") {
        // Emit arguments
        let args: string[] = [];
        let argsType: Type[] = [];
        for (let arg of tree.args) {
          args.push(paren(emit(emitter, arg)));
          let [typ,] = emitter.ir.type_table[arg.id!];
          argsType.push(typ);
        }
        let func = (tree.fun as ast.LookupNode).ident;

        let res = getFunc(func, argsType);
        
        if (res !== null) {
          return `${res}(${args.join(", ")})`;
        }
      }

      // An ordinary function call.
      return ast_visit(js.compile_rules, tree, emitter);
    },

    visit_unary(tree: ast.UnaryNode, emitter: Emitter): string {
      let [typExpr,] = emitter.ir.type_table[tree.expr.id!];
      let expr = paren(emit(emitter, tree.expr));
      let res = getFunc(tree.op, [typExpr]);

      if (res !== null) {
        return `${res}(${expr})`;
      }

      return ast_visit(js.compile_rules, tree, emitter);
    },

    visit_binary(tree: ast.BinaryNode, emitter: Emitter): string {
      let [typL,] = emitter.ir.type_table[tree.lhs.id!];
      let [typR,] = emitter.ir.type_table[tree.rhs.id!];
      let lhs = paren(emit(emitter, tree.lhs));
      let rhs = paren(emit(emitter, tree.rhs));
      let res = getFunc(tree.op, [typL, typR]);

      if (res !== null) {
        return `${res}(${lhs}, ${rhs})`;
      }

      // Otherwise, use the ordinary JavaScript backend.
      return ast_visit(js.compile_rules, tree, emitter);
    },
  });

function emit_glsl_prog(emitter: Emitter, prog: Prog,
  variant: Variant | null): string {
  let out = "";

  // Emit subprograms.
  for (let subid of prog.quote_children) {
    let subprog = emitter.ir.progs[subid];
    if (subprog.annotation !== SHADER_ANNOTATION) {
      throw "error: subprograms not allowed in shaders";
    }
    out += emit_glsl_prog(emitter, subprog, variant);
  }

  // Emit the shader program.
  let code = glsl.compile_prog(emitter, prog.id!);
  let name = progsym(prog.id!) + variant_suffix(variant);
  out += js.emit_var(name, js.emit_string(code), true) + "\n";

  // If it's a *vertex shader* quote (i.e., a top-level shader quote),
  // emit its setup code too.
  if (prog_kind(emitter.ir, prog.id!) === ProgKind.vertex) {
    out += emit_shader_setup(emitter, prog.id!, variant);
  }

  return out;
}

// Compile the IR to a JavaScript program that uses WebGL and GLSL.
export function codegen(ir: CompilerIR): string {
  let emitter: Emitter = {
    ir: ir,
    emit_expr: (tree: ast.SyntaxNode, emitter: Emitter) =>
      ast_visit(compile_rules, tree, emitter),
    emit_proc: js.emit_proc,

    emit_prog(emitter: Emitter, prog: Prog) {
      // Choose between emitting JavaScript and GLSL.
      if (prog.annotation === SHADER_ANNOTATION) {
        return emit_glsl_prog(emitter, prog, null);
      } else {
        return js.emit_prog(emitter, prog);
      }
    },

    emit_prog_variant(emitter: Emitter, variant: Variant, prog: Prog) {
      if (prog.annotation === SHADER_ANNOTATION) {
        return emit_glsl_prog(emitter, prog, variant);
      } else {
        return js.emit_prog_variant(emitter, variant, prog);
      }
    },

    variant: null,
  };

  // Wrap up the setup code with the main function(s).
  return js.emit_main_wrapper(emit_main(emitter), false);
}
