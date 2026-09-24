"""Generate a Blender scene for the Foundry agent capability pipeline.

Run from the repository root with:
  blender --background --python artifacts/blender/generate_foundry_pipeline.py

The script creates artifacts/blender/foundry_pipeline.blend and exports
artifacts/blender/foundry_pipeline.glb when Blender is available.
"""

from __future__ import annotations

from math import pi, radians
from pathlib import Path

import bpy


ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "artifacts" / "blender"


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()


def material(name: str, color: tuple[float, float, float, float], roughness: float = 0.72):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = 0.05
    return mat


MATS = {}


def setup_materials() -> None:
    MATS.update(
        {
            "foundation": material("mat_foundation_graphite", (0.05, 0.06, 0.07, 1)),
            "task": material("mat_task_blue", (0.12, 0.34, 0.70, 1)),
            "explore": material("mat_exploration_teal", (0.02, 0.55, 0.57, 1)),
            "capture": material("mat_capture_green", (0.12, 0.58, 0.25, 1)),
            "compiler": material("mat_compiler_gold", (0.93, 0.62, 0.16, 1)),
            "verify": material("mat_verify_crimson", (0.72, 0.16, 0.22, 1)),
            "policy": material("mat_policy_violet", (0.36, 0.22, 0.76, 1)),
            "registry": material("mat_registry_cyan", (0.05, 0.51, 0.82, 1)),
            "runtime": material("mat_runtime_lime", (0.47, 0.70, 0.18, 1)),
            "arrow": material("mat_arrow_light", (0.76, 0.82, 0.88, 1), 0.48),
            "text": material("mat_text_warm_white", (0.92, 0.90, 0.84, 1), 0.5),
            "dark_text": material("mat_text_dark", (0.04, 0.05, 0.06, 1), 0.5),
            "accent": material("mat_foundry_accent", (1.0, 0.74, 0.28, 1), 0.4),
            "wire": material("mat_dependency_wire", (0.52, 0.68, 0.78, 1), 0.35),
        },
    )


def cube_obj(
    name: str,
    loc: tuple[float, float, float],
    scale: tuple[float, float, float],
    mat_name: str,
    bevel: float = 0.08,
):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(MATS[mat_name])
    if bevel:
        bevel_mod = obj.modifiers.new("softened_edges", "BEVEL")
        bevel_mod.width = bevel
        bevel_mod.segments = 3
        obj.modifiers.new("weighted_normals", "WEIGHTED_NORMAL")
    return obj


def text_obj(
    name: str,
    text: str,
    loc: tuple[float, float, float],
    size: float = 0.22,
    align: str = "CENTER",
    mat_name: str = "text",
):
    bpy.ops.object.text_add(location=loc, rotation=(radians(70), 0, 0))
    obj = bpy.context.object
    obj.name = name
    obj.data.body = text
    obj.data.align_x = align
    obj.data.align_y = "CENTER"
    obj.data.size = size
    obj.data.extrude = 0.01
    obj.data.materials.append(MATS[mat_name])
    return obj


def arrow(name: str, start_x: float, end_x: float, y: float, z: float) -> None:
    length = end_x - start_x
    mid_x = start_x + length / 2
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=24,
        radius=0.045,
        depth=max(length - 0.34, 0.1),
        location=(mid_x - 0.12, y, z),
        rotation=(0, pi / 2, 0),
    )
    shaft = bpy.context.object
    shaft.name = f"{name}_shaft"
    shaft.data.materials.append(MATS["arrow"])
    bpy.ops.mesh.primitive_cone_add(
        vertices=32,
        radius1=0.14,
        radius2=0,
        depth=0.34,
        location=(end_x - 0.17, y, z),
        rotation=(0, pi / 2, 0),
    )
    head = bpy.context.object
    head.name = f"{name}_head"
    head.data.materials.append(MATS["arrow"])


def add_pipeline() -> None:
    stages = [
        ("Task", "task", "User goal"),
        ("Explore", "explore", "Agent run"),
        ("Capture", "capture", "Trajectory"),
        ("Compile", "compiler", "Typed wrapper"),
        ("Validate", "compiler", "Schema"),
        ("Sandbox", "verify", "Failure tests"),
        ("Approve", "policy", "Policy gate"),
        ("Registry", "registry", "Versioned cap"),
        ("Runtime", "runtime", "Monitored exec"),
    ]
    spacing = 2.25
    start = -spacing * (len(stages) - 1) / 2

    for i, (label, mat_name, sublabel) in enumerate(stages):
        x = start + i * spacing
        height = 1.0 + (i % 3) * 0.16
        cube_obj(
            f"stage_{i + 1:02d}_{label.lower()}",
            (x, 0, height / 2),
            (1.35, 1.0, height),
            mat_name,
        )
        cube_obj(
            f"stage_{i + 1:02d}_cap",
            (x, 0, height + 0.09),
            (1.12, 0.82, 0.08),
            "accent" if i in {3, 6, 8} else "arrow",
            0.03,
        )
        text_obj(f"label_{label.lower()}", label, (x, -0.57, height + 0.27), 0.21)
        text_obj(f"sublabel_{label.lower()}", sublabel, (x, -0.57, height + 0.03), 0.13)
        if i < len(stages) - 1:
            arrow(f"flow_{i + 1:02d}_{i + 2:02d}", x + 0.76, x + spacing - 0.76, 0, 0.74)

    cube_obj("pipeline_base", (0, 0, -0.08), (21.2, 1.6, 0.16), "foundation", 0.04)
    text_obj("title", "Foundry capability compiler", (0, -1.45, 1.95), 0.34)
    text_obj("subtitle", "explore -> extract -> verify -> approve -> run", (0, -1.45, 1.58), 0.18)


def add_runtime_orbit() -> None:
    bpy.ops.mesh.primitive_torus_add(
        major_radius=1.0,
        minor_radius=0.035,
        major_segments=96,
        minor_segments=12,
        location=(8.95, 0, 1.2),
        rotation=(pi / 2, 0, 0),
    )
    torus = bpy.context.object
    torus.name = "runtime_monitoring_orbit"
    torus.scale = (1.0, 0.62, 1.0)
    torus.data.materials.append(MATS["wire"])
    text_obj("runtime_badge", "audit + rollback", (8.95, 0.63, 2.12), 0.15)

    for idx, angle in enumerate((0, 120, 240)):
        bpy.ops.mesh.primitive_uv_sphere_add(
            segments=24,
            ring_count=12,
            radius=0.13,
            location=(
                8.95 + 0.95 * __import__("math").cos(radians(angle)),
                0.55 * __import__("math").sin(radians(angle)),
                1.2,
            ),
        )
        node = bpy.context.object
        node.name = f"telemetry_node_{idx + 1}"
        node.data.materials.append(MATS["accent"])


def add_policy_gate() -> None:
    x = 4.5
    cube_obj("approval_gate_left_post", (x - 0.55, 0.62, 0.75), (0.14, 0.2, 1.5), "policy", 0.025)
    cube_obj("approval_gate_right_post", (x + 0.55, 0.62, 0.75), (0.14, 0.2, 1.5), "policy", 0.025)
    cube_obj("approval_gate_top", (x, 0.62, 1.52), (1.24, 0.2, 0.14), "policy", 0.025)
    text_obj("approval_gate_label", "human approval", (x, 0.92, 1.76), 0.13)


def add_lighting_camera() -> None:
    bpy.ops.object.light_add(type="AREA", location=(0, -6, 6))
    key = bpy.context.object
    key.name = "large_softbox_key_light"
    key.data.energy = 650
    key.data.size = 6

    bpy.ops.object.light_add(type="POINT", location=(-7, 4, 4))
    fill = bpy.context.object
    fill.name = "cool_fill_light"
    fill.data.energy = 120
    fill.data.color = (0.55, 0.7, 1.0)

    bpy.ops.object.camera_add(location=(0, -10.2, 5.8), rotation=(radians(60), 0, 0))
    camera = bpy.context.object
    bpy.context.scene.camera = camera
    camera.name = "camera_pipeline_orthographic"
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 12.4

    bpy.context.scene.render.engine = "CYCLES"
    bpy.context.scene.cycles.samples = 96
    bpy.context.scene.view_settings.view_transform = "Filmic"
    bpy.context.scene.view_settings.look = "Medium High Contrast"
    bpy.context.scene.world.color = (0.018, 0.02, 0.024)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    clear_scene()
    setup_materials()
    add_pipeline()
    add_policy_gate()
    add_runtime_orbit()
    add_lighting_camera()

    blend_path = OUT_DIR / "foundry_pipeline.blend"
    glb_path = OUT_DIR / "foundry_pipeline.glb"
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))
    bpy.ops.export_scene.gltf(filepath=str(glb_path), export_format="GLB")
    print(f"Wrote {blend_path}")
    print(f"Wrote {glb_path}")


if __name__ == "__main__":
    main()
