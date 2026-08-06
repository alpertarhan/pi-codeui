# Terminal font profiles

These examples are **user-managed host terminal configuration**. pi-codeui does not change font family, size, features, or ligatures. Install the named Nerd Font yourself, then adjust the examples to taste.

## Ghostty

`~/.config/ghostty/config`:

```ini
font-family = JetBrainsMono Nerd Font
font-size = 13
font-feature = +calt
```

## Kitty

`~/.config/kitty/kitty.conf`:

```conf
font_family JetBrainsMono Nerd Font
font_size 13.0
disable_ligatures never
```

## WezTerm

`~/.wezterm.lua`:

```lua
local wezterm = require "wezterm"
return {
  font = wezterm.font("JetBrainsMono Nerd Font", { harfbuzz_features = { "calt" } }),
  font_size = 13.0,
}
```

Use `glyphPreset: "unicode"` or `"ascii"` in `codeui.settings.json` when Nerd Font glyphs are unavailable. Run `/codeui-doctor` to inspect samples.
