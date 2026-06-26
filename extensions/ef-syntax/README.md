# ElasticFunnels Syntax

Syntax highlighting for ElasticFunnels `.ef` template files.

`.ef` files are HTML with the ElasticFunnels template engine layered on top:

- `{{ variable }}` and `{{ value | filter:arg }}` interpolation
- `{{-- comments --}}`
- Blade-style directives: `@if / @elseif / @else / @endif`, `@foreach … @endforeach`,
  `@set`, `@component … @endcomponent`, `@extends`, `@block … @endblock`, `@yield`,
  `@splittest … @endsplittest`

This extension is **grammar only** — no code, no telemetry, no settings. It is
installed for you by the ElasticFunnels CLI:

```sh
ef install-highlighter
```

which runs `<editor> --install-extension` against whichever editor it finds
(Cursor, VS Code, VSCodium, …). You can also install the bundled `.vsix` by hand:

```sh
code --install-extension ef-syntax-0.1.0.vsix     # or: cursor / codium / code-insiders
```

## Known limitation

Interpolation inside HTML attribute values (e.g. `<a href="{{ url }}">`) is not
yet specially colored — the surrounding HTML still highlights normally. Directives
and `{{ }}` in element text and on their own lines are fully highlighted.
