# Third-party notices

This project depends on the following runtime packages. Versions are pinned in
`package-lock.json`. Their licenses apply to those packages, not to this project's original code.

## Runtime dependencies

### @modelcontextprotocol/sdk

- Version: 1.32.2
- License: MIT
- Copyright (c) 2024 Anthropic, PBC
- Project: https://modelcontextprotocol.io

### better-sqlite3

- Version: 13.0.3
- License: MIT
- Copyright (c) 2017 Joshua Wise
- Project: https://github.com/WiseLibs/better-sqlite3

### yaml

- Version: 2.9.1
- License: ISC
- Copyright Eemeli Aro <eemeli@gmail.com>
- Project: https://eemeli.org/yaml/

### zod

- Version: 4.6.7
- License: MIT
- Copyright (c) 2025 Colin McDonnell
- Project: https://zod.dev

## Reviewed community reference

The optional TimeTree adapter was written after reviewing the protocol behavior and endpoint shapes
of:

- Project: `ehs208/TimeTree-MCP`
- Reviewed commit: `3f77995f4d074364c6ffe14bb95a9d0c43a7c1d8`
- URL: https://github.com/ehs208/TimeTree-MCP/commit/3f77995f4d074364c6ffe14bb95a9d0c43a7c1d8
- License: MIT
- Copyright (c) 2026 TimeTree MCP Contributors

This project does not vendor that project's installer or its broad tool surface. The local adapter
implements only the narrow provider interface described in `docs/ARCHITECTURE.md`. The upstream
project's license is reproduced below as a courtesy and to preserve attribution for the reviewed
reference.

```text
MIT License

Copyright (c) 2026 TimeTree MCP Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Dependency license texts

The following license texts are reproduced for the runtime dependencies. The copyright holders and
package names above identify which text applies to which package.

### MIT License text (MCP SDK, better-sqlite3, zod)

```text
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### ISC License text (yaml)

```text
Copyright Eemeli Aro <eemeli@gmail.com>

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

## Trademarks

TimeTree is a trademark of its respective owner. This project is not affiliated with, endorsed by,
or supported by TimeTree. The community provider is unofficial.
