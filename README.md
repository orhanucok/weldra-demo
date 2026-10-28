# Weldra Arc — recorded demo

Weldra programs welding robots from a prompt. This page replays recorded runs in the
browser: each job was typed as a prompt, planned by Weldra (seam finding, pass
planning, UR10e reach / collision / singularity checks, UR clamp-zone limits,
collision-free transits), independently re-checked, and turned into a robot program
(URScript for UR e-Series, FANUC TP draft).

Two of the programs were executed on **URSim 5.26**, Universal Robots' controller
simulator; the logged joint positions are compared with the plan in the
"Run on UR's controller" panel.

Status: simulation and URSim only — not yet a physical robot. The planner itself is
not part of this repository.

Open `index.html` through any static web server, or visit the GitHub Pages site.
