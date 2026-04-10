
- keep the undo/redo arrow from @index.html#L56-57  but draw it upside down with css scaleY(-1)

- in tracks, seleting a file should not just fit it to screen (that works), it should also select - and so, make thicker - all its tracks (opr at least the first one if it's easier)

- the name given to a file with only 1 track should be given to it as well (KISS)
- bug: the default name in the text field when I export file is 'Track x' even if I have renamed it

commit

- in profile panel the default 'profile smoothing' slider value should be 20 and slider should get up to 100. also make number value editable on double-click, with no limit

commit

- let me set map dpi independently from the rest of the buttons/panels

commit

---

I've removed the profile smoothing slider test, it didn't add much.
let me also clarify the name stuff:
- 'file' node name = imported from the OS file path basename on import and used   (seems to work OK now)
- 'track' node name = import/export from/to <trk><name> xml (OK) ; and **changed when file node is renamed and only 1 track inside. (still not working)**
- the issue I keep having is that 'Export active GPX' export just the active track, wheras I want it to act at file level.

continue with all git commits and tasks

---

the waypoints of a gpx file are put at the global level on import, instead of under the file. fix and commit

---

- make middle click on a track panel node to delete ;
- in layer order middle click on a map layer  to remove (this does not bypass the dialog)
- make "add tilejson" less high and put it at the bottom of the layer settings
- add "OPFS quota" in the settings > storage part using  navigator.storage.estimate() 
- add a real '+'/'-' instead of the dot in the track list panel