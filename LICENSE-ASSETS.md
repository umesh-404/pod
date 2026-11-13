# Pod — assets

Pod is a fork of [Coucou](https://github.com/Louis-CFM/coucou) by Louis Raillé. The [MIT License](LICENSE) covers the **source code**, Coucou's and Pod's.

Pod no longer carries any of Coucou's assets. Each was replaced with Pod's own:

- **The character.** Coucou's character, Mochi, was replaced by **Stew**, a glossy green ball drawn in code (`windows/src/mochi/stew.ts`, `engine.ts`, `greeting.ts`, `outfits.ts`). © Pod contributors, under the project's [MIT License](LICENSE). The folder, the `mochi` window label and the `desktop_mochi` setting keep their old names so existing settings keep working. These are internal identifiers and never appear in the app.
- **The app and tray icons** (`windows/src-tauri/icons/`). Stew, drawn as hand-written SVGs in `windows/src-tauri/icons/source/` and rendered by `windows/scripts/gen-icons.mjs`. © Pod contributors, under the project's [MIT License](LICENSE).
- **The sounds** (`windows/sounds/`). Generated from code by `windows/scripts/make-sounds.py`. © Pod contributors, under the project's [MIT License](LICENSE).

The **typeface**, Nilo (`windows/public/fonts/nilo/`), is Pod's own. © umesh-404, under the [SIL Open Font License 1.1](windows/public/fonts/nilo/OFL.txt), not the MIT License.

Coucou's own name, character and artwork remain the property of their author. Questions about them go to [Coucou's GitHub](https://github.com/Louis-CFM/coucou/issues).
