import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/analysis/graph.js";
import { extractImports } from "../src/analysis/imports.js";
import { traceFeature } from "../src/analysis/trace.js";
import { tempDir, writeFiles } from "./helpers.js";

const MAX = 1_000_000;

/** Traces one seed through the real graph. Returns the closure's sorted paths and the packages it could not place. */
async function traced(files: Record<string, string>, seed: string) {
  const root = tempDir();
  writeFiles(root, files);
  const graph = await buildGraph(root, MAX, { useCache: false });
  const trace = traceFeature(graph, { seeds: [seed] });
  return { paths: trace.files.map((file) => file.path).sort(), external: trace.external_packages };
}

describe("JVM package roots", () => {
  const main = "src/main/kotlin/com/acme/Main.kt";

  it.each([
    ["the standard source root", "src/main/java/com/acme/ui/Button.java", "com.acme.ui"],
    ["an Android module directory", "app/src/main/java/com/acme/ui/Button.kt", "com.acme.ui"],
    ["a server directory named app", "server/app/com/acme/ui/Button.kt", "com.acme.ui"],
    ["a net package in a module named app", "app/net/acme/ui/Button.kt", "net.acme.ui"],
    ["an io package in a module named app", "server/app/io/acme/ui/Button.kt", "io.acme.ui"],
    ["a de package under the source root", "src/main/java/de/acme/ui/Button.java", "de.acme.ui"],
    ["a uk package under the Kotlin source root", "src/main/kotlin/uk/acme/ui/Button.kt", "uk.acme.ui"],
  ])("links a class under %s", async (_label, button, pkg) => {
    const result = await traced({ [main]: `import ${pkg}.Button\n`, [button]: "" }, main);
    expect(result).toEqual({ paths: [button, main].sort(), external: [] });
  });

  it("links a wildcard import to the files directly under its package", async () => {
    const files = {
      "src/main/java/com/acme/model/Book.java": "package com.acme.model;\n",
      "src/main/java/com/acme/model/Author.java": "package com.acme.model;\n",
      "src/main/java/com/acme/model/deep/Deep.java": "package com.acme.model.deep;\n",
      "src/main/java/com/acme/Wild.java":
        "package com.acme;\nimport com.acme.model.*;\nclass Wild { Book book; Author author; }\n",
      "src/main/kotlin/com/acme/KotlinWild.kt":
        "package com.acme\nimport com.acme.model.*\nval book: Book? = null\nval author: Author? = null\n",
    };
    expect(await traced(files, "src/main/java/com/acme/Wild.java")).toEqual({
      paths: [
        "src/main/java/com/acme/Wild.java",
        "src/main/java/com/acme/model/Author.java",
        "src/main/java/com/acme/model/Book.java",
      ].sort(),
      external: [],
    });
    expect(await traced(files, "src/main/kotlin/com/acme/KotlinWild.kt")).toEqual({
      paths: [
        "src/main/kotlin/com/acme/KotlinWild.kt",
        "src/main/java/com/acme/model/Author.java",
        "src/main/java/com/acme/model/Book.java",
      ].sort(),
      external: [],
    });
  });

  it("links static members and static wildcard imports to their class", async () => {
    const files = {
      "src/main/java/com/acme/Util.java": "package com.acme;\npublic class Util {}\n",
      "src/main/java/com/acme/StaticMember.java": "package com.acme;\nimport static com.acme.Util.helper;\n",
      "src/main/java/com/acme/StaticWild.java": "package com.acme;\nimport static com.acme.Util.*;\n",
    };
    expect(await traced(files, "src/main/java/com/acme/StaticMember.java")).toEqual({
      paths: ["src/main/java/com/acme/StaticMember.java", "src/main/java/com/acme/Util.java"].sort(),
      external: [],
    });
    expect(await traced(files, "src/main/java/com/acme/StaticWild.java")).toEqual({
      paths: ["src/main/java/com/acme/StaticWild.java", "src/main/java/com/acme/Util.java"].sort(),
      external: [],
    });
  });

  it("keeps direct class imports working", async () => {
    const files = {
      "src/main/java/com/acme/model/Book.java": "package com.acme.model;\n",
      "src/main/java/com/acme/Direct.java": "package com.acme;\nimport com.acme.model.Book;\n",
    };
    expect(await traced(files, "src/main/java/com/acme/Direct.java")).toEqual({
      paths: ["src/main/java/com/acme/Direct.java", "src/main/java/com/acme/model/Book.java"],
      external: [],
    });
  });

  it("still reports unknown packages as external", async () => {
    const result = await traced(
      { "src/main/java/com/acme/A.java": "import com.google.common.collect.*;\nimport java.util.List;\n" },
      "src/main/java/com/acme/A.java",
    );
    expect(result).toEqual({ paths: ["src/main/java/com/acme/A.java"], external: ["com.google.common"] });
  });
});

describe("Go modules", () => {
  it.each([
    ["examples/go.mod", "example.com/examples"],
    ["_examples/go.mod", "example.com/_examples"],
    ["api/go.mod", "example.com/api"],
  ])("resolves in-repo imports when %s sorts before the root go.mod", async (nested, modulePath) => {
    const result = await traced(
      {
        "go.mod": "module github.com/acme/app\n\ngo 1.24\n",
        [nested]: `module ${modulePath}\n\ngo 1.24\n`,
        "cmd/app/main.go": 'package main\n\nimport "github.com/acme/app/internal/store"\n',
        "internal/store/store.go": "package store\n",
      },
      "cmd/app/main.go",
    );
    expect(result).toEqual({ paths: ["cmd/app/main.go", "internal/store/store.go"], external: [] });
  });

  it("keeps resolving when a nested module sorts after the root", async () => {
    const result = await traced(
      {
        "go.mod": "module github.com/acme/app\n\ngo 1.24\n",
        "tools/go.mod": "module example.com/tools\n\ngo 1.24\n",
        "cmd/app/main.go": 'package main\n\nimport "github.com/acme/app/internal/store"\n',
        "internal/store/store.go": "package store\n",
      },
      "cmd/app/main.go",
    );
    expect(result).toEqual({ paths: ["cmd/app/main.go", "internal/store/store.go"], external: [] });
  });

  it("prefers the longest module path when one module path prefixes another", async () => {
    const result = await traced(
      {
        "go.mod": "module example.com/m\n\ngo 1.24\n",
        "vendored/go.mod": "module example.com/m/lib\n\ngo 1.24\n",
        "vendored/util/util.go": "package util\n",
        "main.go": 'package main\n\nimport "example.com/m/lib/util"\n',
      },
      "main.go",
    );
    expect(result).toEqual({ paths: ["main.go", "vendored/util/util.go"], external: [] });
  });
});

describe("Rust module paths", () => {
  it("resolves self:: and super:: from a named module's own directory", async () => {
    const result = await traced(
      {
        "src/parser/expr.rs": "mod helpers;\nuse self::helpers::Node;\nuse super::lexer::Token;\n",
        "src/parser/expr/helpers.rs": "",
        "src/parser/helpers.rs": "",
        "src/parser/lexer.rs": "",
        "src/lexer.rs": "",
      },
      "src/parser/expr.rs",
    );
    expect(result).toEqual({
      paths: ["src/parser/expr.rs", "src/parser/expr/helpers.rs", "src/parser/lexer.rs"].sort(),
      external: [],
    });
  });

  it("resolves super:: from a named file at the crate root", async () => {
    const result = await traced({ "src/a.rs": "use super::b::B;\n", "src/b.rs": "" }, "src/a.rs");
    expect(result).toEqual({ paths: ["src/a.rs", "src/b.rs"], external: [] });
  });

  it("keeps mod.rs super paths and child modules working", async () => {
    const result = await traced(
      {
        "src/parser/mod.rs": "mod expr;\nuse super::lexer::Token;\n",
        "src/parser/expr.rs": "",
        "src/lexer.rs": "",
      },
      "src/parser/mod.rs",
    );
    expect(result).toEqual({
      paths: ["src/lexer.rs", "src/parser/expr.rs", "src/parser/mod.rs"].sort(),
      external: [],
    });
  });
});

describe("Python import lists with comments", () => {
  const pkg = { "pkg/__init__.py": "", "pkg/cli.py": "", "pkg/api.py": "" };
  const expected = ["main.py", "pkg/__init__.py", "pkg/api.py", "pkg/cli.py"];

  it.each([
    ["no comment", "from pkg import (\n    cli,\n    api,\n)\n"],
    ["a comment on the opening line", "from pkg import (  # noqa\n    cli,\n    api,\n)\n"],
    ["a comment after a name", "from pkg import (\n    cli,  # the cli module\n    api,\n)\n"],
    ["a parenthesis inside a comment", "from pkg import (\n    cli,  # see (docs\n    api,  # the api)\n)\n"],
    [
      "a hash in a string above the import",
      'LABEL = "#fff"\nfrom pkg import (  # noqa\n    cli,\n    api,\n)\n',
    ],
  ])("links every submodule named in a list with %s", async (_label, main) => {
    expect(await traced({ ...pkg, "main.py": main }, "main.py")).toEqual({ paths: expected, external: [] });
  });

  it("keeps a single import with a trailing comment working", async () => {
    expect(await traced({ ...pkg, "main.py": "from pkg import cli  # it's used\n" }, "main.py")).toEqual({
      paths: ["main.py", "pkg/__init__.py", "pkg/cli.py"],
      external: [],
    });
  });
});

describe("wildcard imports link what the file names", () => {
  it("leaves out classes the file never mentions", async () => {
    const files = {
      "src/main/java/com/acme/model/Book.java": "package com.acme.model;\n",
      "src/main/java/com/acme/model/Other.java": "package com.acme.model;\n",
      "src/main/java/com/acme/Wild.java":
        "package com.acme;\nimport com.acme.model.*;\nclass Wild { Book b; }\n",
    };
    expect((await traced(files, "src/main/java/com/acme/Wild.java")).paths).toEqual([
      "src/main/java/com/acme/Wild.java",
      "src/main/java/com/acme/model/Book.java",
    ]);
  });

  it("does not push an explicitly imported class out of the closure by fan-in", async () => {
    const wild = "package com.acme.app;\nimport com.acme.model.*;\nclass X {}\n";
    const files: Record<string, string> = {
      "src/main/java/com/acme/model/Gpl.java": "package com.acme.model;\n",
      "src/main/java/com/acme/app/Seed.java": "package com.acme.app;\nimport com.acme.model.Gpl;\n",
    };
    for (let index = 0; index < 9; index++) files[`src/main/java/com/acme/app/W${index}.java`] = wild;
    expect((await traced(files, "src/main/java/com/acme/app/Seed.java")).paths).toContain(
      "src/main/java/com/acme/model/Gpl.java",
    );
  });

  it("stays cheap on a package many files import", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 1500; index++) {
      files[`src/main/java/com/acme/model/C${index}.java`] = "package com.acme.model;\n";
      files[`src/main/java/com/acme/app/U${index}.java`] =
        "package com.acme.app;\nimport com.acme.model.*;\nclass U { C1 c; }\n";
    }
    const root = tempDir();
    writeFiles(root, files);
    const graph = await buildGraph(root, MAX, { useCache: false });
    const edges = [...graph.nodes.values()].reduce((total, node) => total + node.internal.size, 0);
    expect(edges).toBe(1500);
  }, 60_000);
});

describe("Rust use trees", () => {
  const lexer = { "src/lexer.rs": "pub struct Lexer;\n", "src/parser.rs": "pub struct Parser;\n" };

  it.each([
    ["a group", "use crate::{parser::Parser, lexer::Lexer};\n"],
    [
      "a group over several lines",
      "use crate::{\n    parser::Parser, // the parser\n    lexer::Lexer,\n};\n",
    ],
    ["a nested group", "use crate::{parser::{self, Parser}, lexer::{Lexer}};\n"],
    ["an alias", "use crate::{parser::Parser as P, lexer::Lexer as L};\n"],
    ["a public group", "pub(crate) use crate::{parser::Parser, lexer::Lexer};\n"],
  ])("follows %s", async (_label, main) => {
    const { paths } = await traced({ ...lexer, "src/main.rs": main }, "src/main.rs");
    expect(paths).toEqual(["src/lexer.rs", "src/main.rs", "src/parser.rs"]);
  });

  it("follows an attribute on the same line", async () => {
    const main = '#[allow(unused)] use crate::lexer::Lexer;\n#[cfg(feature = "x")] pub mod parser;\n';
    const { paths } = await traced({ ...lexer, "src/main.rs": main }, "src/main.rs");
    expect(paths).toEqual(["src/lexer.rs", "src/main.rs", "src/parser.rs"]);
  });

  it("does not take a block module for a declaration", async () => {
    const main = "mod lexer {\n    pub struct Inline;\n}\nfn main() {}\n";
    const { paths } = await traced({ ...lexer, "src/main.rs": main }, "src/main.rs");
    expect(paths).toEqual(["src/main.rs"]);
  });

  it("climbs through super::super", async () => {
    const { paths } = await traced(
      {
        "src/parser/lexer.rs": "pub struct Token;\n",
        "src/parser/expr/deep.rs": "use super::super::lexer::Token;\n",
      },
      "src/parser/expr/deep.rs",
    );
    expect(paths).toContain("src/parser/lexer.rs");
  });

  it("reads super::* as the parent module", async () => {
    const { paths } = await traced(
      { "src/parser.rs": "pub struct Parser;\n", "src/parser/expr.rs": "use super::*;\n" },
      "src/parser/expr.rs",
    );
    expect(paths).toContain("src/parser.rs");
  });

  it("survives a hostile use tree in reasonable time", async () => {
    const started = Date.now();
    const size = 1024 * 1024;
    for (const text of [
      `use a::${"{".repeat(size)}`,
      "use a\n".repeat(size / 6),
      "#[a]\n".repeat(size / 5),
      "pub(\n".repeat(size / 5),
      "use a;\n".repeat(size / 7),
      `use a${"/*".repeat(size / 2)};`,
    ]) {
      extractImports("src/a.rs", text);
    }
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("Python statements", () => {
  const pkg = {
    "pkg/__init__.py": "",
    "pkg/cli.py": "x = 1\n",
    "pkg/api.py": "y = 1\n",
  };

  it.each([
    ["a semicolon", "import os; from pkg import cli\n"],
    ["a one-line if", "if TYPE_CHECKING: from pkg import cli\n"],
    ["a one-line try", "try: from pkg import cli\nexcept ImportError: pass\n"],
    ["a backslash", "from pkg import \\\n    cli\n"],
    ["a long list", `from pkg import (\n${"    other,\n".repeat(520)}    cli,\n)\n`],
  ])("follows an import after %s", async (_label, main) => {
    const { paths } = await traced({ ...pkg, "main.py": main }, "main.py");
    expect(paths).toContain("pkg/cli.py");
  });
});

describe("Go module paths", () => {
  const importer =
    'package main\n\nimport "github.com/acme/app/internal/store"\n\nfunc main() { store.Open() }\n';

  it("reads a quoted module line", async () => {
    const { paths } = await traced(
      {
        "go.mod": 'module "github.com/acme/app"\n\ngo 1.22\n',
        "cmd/app/main.go": importer,
        "internal/store/store.go": "package store\n",
      },
      "cmd/app/main.go",
    );
    expect(paths).toContain("internal/store/store.go");
  });

  it("prefers the root over a deeper copy of the same module path", async () => {
    const { paths } = await traced(
      {
        "go.mod": "module github.com/acme/app\n\ngo 1.22\n",
        "aaa/go.mod": "module github.com/acme/app\n\ngo 1.22\n",
        "aaa/internal/store/store.go": "package store\n",
        "cmd/app/main.go": importer,
        "internal/store/store.go": "package store\n",
      },
      "cmd/app/main.go",
    );
    expect(paths).toContain("internal/store/store.go");
    expect(paths).not.toContain("aaa/internal/store/store.go");
  });

  it("keeps a vendored module external", async () => {
    const { external } = await traced(
      {
        "go.mod": "module github.com/acme/app\n\nrequire github.com/foo/bar v1.0.0\n",
        "cmd/app/main.go": 'package main\n\nimport "github.com/foo/bar"\n\nfunc main() { bar.Do() }\n',
        "legacy/vendor/github.com/foo/bar/go.mod": "module github.com/foo/bar\n",
        "legacy/vendor/github.com/foo/bar/bar.go": "package bar\n",
      },
      "cmd/app/main.go",
    );
    expect(external).toContain("github.com/foo/bar");
  });
});

describe("second review: Rust", () => {
  it("reads super inside an inline test module as the file itself", async () => {
    const { paths } = await traced(
      {
        "src/lib.rs": "pub mod foo;\npub mod bar;\n",
        "src/bar.rs": "pub struct Bar;\n",
        "src/foo.rs": "pub fn f() {}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n}\n",
      },
      "src/foo.rs",
    );
    expect(paths).toEqual(["src/foo.rs"]);
  });

  it("follows super past an inline module", async () => {
    const { paths } = await traced(
      {
        "src/parser.rs": "pub struct P;\n",
        "src/parser/expr.rs": "mod tests {\n    use super::super::P;\n}\n",
      },
      "src/parser/expr.rs",
    );
    expect(paths).toContain("src/parser.rs");
  });

  it("does not take local modules, types or macro paths for crates", async () => {
    const { external } = await traced(
      {
        "src/main.rs":
          "mod config;\nuse config::Config;\nuse Direction::*;\nuse $crate::x;\nenum Direction { Up }\n",
        "src/config.rs": "pub struct Config;\n",
      },
      "src/main.rs",
    );
    expect(external).toEqual([]);
  });

  it("treats files under tests/ as crate roots", async () => {
    const { paths } = await traced(
      { "tests/api.rs": "mod common;\n", "tests/common/mod.rs": "pub fn f() {}\n" },
      "tests/api.rs",
    );
    expect(paths).toContain("tests/common/mod.rs");
  });

  it("survives an enormous use tree", () => {
    const prefix = Array.from({ length: 40_000 }, (_, index) => `a${index}`).join("::");
    const leaves = Array.from({ length: 40_000 }, (_, index) => `b${index}`).join(",");
    expect(extractImports("src/a.rs", `use ${prefix}::{${leaves}};`).length).toBeLessThanOrEqual(4096);
  });
});

describe("second review: Python", () => {
  it("does not read a docstring as imports", async () => {
    const { external } = await traced(
      { "main.py": '"""Example:\n\n    import requests\n    from numpy import array\n"""\nimport os\n' },
      "main.py",
    );
    expect(external).toEqual([]);
  });
});

describe("second review: packages", () => {
  it("keeps a Java class used from its own package", async () => {
    const { paths } = await traced(
      {
        "src/main/java/com/x/Service.java": "package com.x;\nclass Service { Repo repo; }\n",
        "src/main/java/com/x/Repo.java": "package com.x;\nclass Repo {}\n",
      },
      "src/main/java/com/x/Service.java",
    );
    expect(paths).toContain("src/main/java/com/x/Repo.java");
  });

  it("keeps the rest of a Go package, however widely it is used", async () => {
    const files: Record<string, string> = {
      "go.mod": "module example.com/m\n",
      "p/a.go": "package p\n\nfunc A() { helper() }\n",
      "p/b.go": "package p\n\nfunc helper() {}\n",
    };
    for (let index = 0; index < 12; index++) files[`p/c${index}.go`] = "package p\n";
    expect((await traced(files, "p/a.go")).paths).toContain("p/b.go");
  });

  it("keeps a wildcard working after a noisy file", async () => {
    const noisy = `package app\n${"import com.x.*\n".repeat(2000)}`;
    const { paths } = await traced(
      {
        "app/A.kt": noisy,
        "app/B.kt": "package app\nimport com.x.*\nfun make() = Foo()\n",
        "com/x/Foo.kt": "package com.x\nclass Foo\n",
      },
      "app/B.kt",
    );
    expect(paths).toContain("com/x/Foo.kt");
  });

  it("stays quick on one package imported many times", async () => {
    const root = tempDir();
    const files: Record<string, string> = {
      "go.mod": "module example.com/m\n",
      "main.go": `package main\n\nimport (\n${'  _ "example.com/m/p"\n'.repeat(20_000)})\n`,
    };
    for (let index = 0; index < 1000; index++) files[`p/f${index}.go`] = "package p\n";
    writeFiles(root, files);
    const started = Date.now();
    await buildGraph(root, 4 * MAX, { useCache: false });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);
});
