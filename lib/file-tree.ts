import type { FileSystemTree } from '@webcontainer/api';
import type { FileMap } from './canvas-types';

export function toFileTree(files: FileMap): FileSystemTree {
  const tree: FileSystemTree = {};
  for (const [path, contents] of Object.entries(files)) {
    const parts = path.split('/');
    let cursor = tree;
    parts.forEach((part, index) => {
      if (index === parts.length - 1) {
        cursor[part] = { file: { contents } };
      } else {
        const current = cursor[part];
        if (!current || !('directory' in current)) cursor[part] = { directory: {} };
        cursor = (cursor[part] as { directory: FileSystemTree }).directory;
      }
    });
  }
  return tree;
}
