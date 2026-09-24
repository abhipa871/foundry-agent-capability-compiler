# Foundry Pipeline Blender Artifact

This directory contains a reproducible Blender scene for the Agent JIT Compiler project.

## Files

- `generate_foundry_pipeline.py`: Blender Python script that builds the scene.
- `foundry_pipeline_preview.obj`: lightweight preview mesh that can be imported into Blender.
- `foundry_pipeline_preview.mtl`: materials for the preview mesh.
- `manifest.json`: artifact metadata and generation notes.

## Generate the `.blend`

Install Blender and run this from the repository root:

```powershell
blender --background --python artifacts/blender/generate_foundry_pipeline.py
```

The script writes:

- `artifacts/blender/foundry_pipeline.blend`
- `artifacts/blender/foundry_pipeline.glb`

## Scene Concept

The scene visualizes the repository pipeline:

`task -> exploration -> trajectory capture -> capability extraction -> schema validation -> sandbox/failure testing -> policy/approval -> registry/deployment -> monitored execution`

The approval gate and monitoring orbit call out the core trust boundaries that separate exploratory agent behavior from approved runtime execution.
