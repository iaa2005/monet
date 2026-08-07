"""
What does an exported graph actually do with its inputs?

Written for one question — how the 1.5 build makes `image_grid_thw` drive a
dynamic position-embedding interpolation — but it answers the general one:
given an .onnx, print its inputs, its outputs, and the chain of nodes that
consume a named input. That chain is the part a re-export has to reproduce.

    .venv/Scripts/python scripts/inspect_graph.py <model.onnx> [input_name]
"""

from __future__ import annotations

import sys
from pathlib import Path

import onnx


def shape_of(value: onnx.ValueInfoProto) -> str:
    dims = []
    for d in value.type.tensor_type.shape.dim:
        dims.append(d.dim_param or str(d.dim_value))
    kind = onnx.TensorProto.DataType.Name(value.type.tensor_type.elem_type)
    return f"{value.name}: {kind}[{', '.join(dims)}]"


def main(path: Path, follow: str | None) -> None:
    model = onnx.load(str(path), load_external_data=False)
    graph = model.graph
    print(f"{path.name}  opset {model.opset_import[0].version}  {len(graph.node)} nodes")
    print("\ninputs")
    for i in graph.input:
        print(f"  {shape_of(i)}")
    print("outputs")
    for o in graph.output:
        print(f"  {shape_of(o)}")

    if not follow:
        return

    # Walk forward from the named input until the trail goes cold, printing
    # every node that touches it. Depth-limited: past a dozen hops it is the
    # whole network rather than the part that reads this input.
    print(f"\nnodes fed by {follow}")
    frontier = {follow}
    seen: set[str] = set()
    for depth in range(14):
        nxt: set[str] = set()
        for node in graph.node:
            if not any(i in frontier for i in node.input):
                continue
            if node.name in seen:
                continue
            seen.add(node.name)
            args = ", ".join(n for n in node.input if n)
            print(f"  {'  ' * depth}{node.op_type}({args}) -> {', '.join(node.output)}")
            nxt.update(node.output)
        if not nxt:
            break
        frontier = nxt


if __name__ == "__main__":
    main(Path(sys.argv[1]), sys.argv[2] if len(sys.argv) > 2 else None)
