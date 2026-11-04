# Pod — assets inherited from Coucou

Pod is a fork of [Coucou](https://github.com/Louis-CFM/coucou) by Louis Raillé. The [MIT License](LICENSE) covers the **source code**. It does **not** cover these assets, which Pod still carries from Coucou and which remain the property of Louis Raillé (all rights reserved):

- the name **“Mochi”** and the **Mochi character**: its design, look, expressions and animations.

The **app icon** and **tray icon** (`windows/src-tauri/icons/`) are no longer Coucou's: they are Pod's own, Stew drawn as hand-written SVGs in `windows/src-tauri/icons/source/` and rendered by `windows/scripts/gen-icons.mjs`, © Pod contributors, under the project's [MIT License](LICENSE).

The **sounds** (`windows/sounds/`) are no longer Coucou's: they are Pod's own, generated from code by `windows/scripts/make-sounds.py`, © Pod contributors, under the project's [MIT License](LICENSE).

The **typeface**, Nilo (`windows/public/fonts/nilo/`), is Pod's own, © umesh-404, under the [SIL Open Font License 1.1](windows/public/fonts/nilo/OFL.txt), not the MIT License.

## Before Pod is distributed

Coucou's terms allow building and running these assets from source for yourself, as they are, but not publishing an app or fork that uses them. **Pod must not ship builds (GitHub releases, installers, packages) until the character is replaced with Pod's own** (the icons and the sounds already are). That redesign is planned. Until it lands, build Pod from source.

Questions about the Coucou assets go to their author: open an issue on [Coucou's GitHub](https://github.com/Louis-CFM/coucou/issues).
