/**
 * SWARMAGENTS - Hierarchy Manager
 *
 * Manages agent parent/child/sibling relationships.
 */

interface HierarchyNode {
    parentId: string | null;
    childIds: Set<string>;
    relationship: string;
}

export class HierarchyManager {
    private nodes: Map<string, HierarchyNode>;
    private roots: Set<string>;

    constructor() {
        this.nodes = new Map(); // id -> { parentId, childIds, relationship }
        this.roots = new Set();
    }

    addAgent(id, parentId = null, relationship = 'child') {
        this.nodes.set(id, {
            parentId,
            childIds: new Set(),
            relationship,
        });

        if (!parentId) {
            this.roots.add(id);
        } else {
            const parent = this.nodes.get(parentId);
            if (parent) {
                parent.childIds.add(id);
            }
        }
    }

    removeAgent(id) {
        const node = this.nodes.get(id);
        if (!node) return;

        // Remove from parent's children
        if (node.parentId) {
            const parent = this.nodes.get(node.parentId);
            if (parent) {
                parent.childIds.delete(id);
            }
        } else {
            this.roots.delete(id);
        }

        // Reassign orphaned children to grandparent
        for (const childId of node.childIds) {
            const child = this.nodes.get(childId);
            if (child) {
                child.parentId = node.parentId;
                if (node.parentId) {
                    const grandparent = this.nodes.get(node.parentId);
                    if (grandparent) grandparent.childIds.add(childId);
                } else {
                    this.roots.add(childId);
                }
            }
        }

        this.nodes.delete(id);
    }

    getParent(id) {
        const node = this.nodes.get(id);
        return node?.parentId || null;
    }

    getChildren(id) {
        const node = this.nodes.get(id);
        return node ? Array.from(node.childIds) : [];
    }

    getSiblings(id) {
        const node = this.nodes.get(id);
        if (!node?.parentId) {
            return [...this.roots].filter(r => r !== id);
        }

        const parent = this.nodes.get(node.parentId);
        return parent ? [...parent.childIds].filter(c => c !== id) : [];
    }

    getAncestors(id) {
        const ancestors = [];
        let current = this.nodes.get(id);

        while (current?.parentId) {
            ancestors.push(current.parentId);
            current = this.nodes.get(current.parentId);
        }

        return ancestors;
    }

    getDescendants(id) {
        const descendants = [];
        const node = this.nodes.get(id);
        if (!node) return descendants;

        const queue = [...node.childIds];
        while (queue.length > 0) {
            const childId = queue.shift();
            descendants.push(childId);
            const child = this.nodes.get(childId);
            if (child) {
                queue.push(...child.childIds);
            }
        }

        return descendants;
    }

    getDepth(id) {
        return this.getAncestors(id).length;
    }

    getTree() {
        const buildTree = (id) => {
            const node = this.nodes.get(id);
            if (!node) return null;

            return {
                id,
                children: [...node.childIds].map(buildTree).filter(Boolean),
            };
        };

        return [...this.roots].map(buildTree).filter(Boolean);
    }

    serialize() {
        const data = {};
        for (const [id, node] of this.nodes) {
            data[id] = {
                parentId: node.parentId,
                childIds: [...node.childIds],
                relationship: node.relationship,
            };
        }
        return data;
    }

    restore(data: Record<string, { parentId: string | null; childIds: string[]; relationship: string }>) {
        this.nodes.clear();
        this.roots.clear();

        for (const [id, node] of Object.entries(data)) {
            this.nodes.set(id, {
                parentId: node.parentId,
                childIds: new Set(node.childIds),
                relationship: node.relationship,
            });

            if (!node.parentId) {
                this.roots.add(id);
            }
        }
    }
}

export default HierarchyManager;
