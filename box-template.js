/* Static physical layout, in the supplied photograph's orientation. Never stored in project data. */
(function (root) {
    const rows = [
        [['B15', 'A9', 'W', 'W'], ['B16', 'A20', 'W', 'W'], ['B17', 'A21', 'W', 'W'], ['B18', 'A22', 'W', 'W'], ['B20', 'A25', 'W', 'W'], ['B33', 'A26', 'W', 'W'], ['B38', 'A33', 'W', 'W']],
        [['B70', 'A38', 'W', 'W'], ['B56', 'A39', 'W', 'W'], ['B57', 'B19', 'W', 'W'], ['B59', 'A10', 'BK', 'BK'], ['B60', 'A11', 'BL', 'BL'], ['B52', 'A12', 'BK', 'BK'], ['B51', 'A13', 'BL', 'BL']],
        [['B63', 'A23', 'BK', 'BK'], ['B64', 'A24', 'BL', 'BL'], ['B13', 'A35', 'BK', 'BK'], ['B14', 'A34', 'BL', 'BL'], ['B49', 'B66', 'BK', 'BK'], ['B50', 'B65', 'BL', 'BL'], ['B31', 'A36', 'BK', 'BK']],
        [['B32', 'A37', 'BL', 'BL'], ['B67', 'A49', 'BK', 'BK'], ['B68', 'A50', 'BL', 'BL'], ['B34', 'B62', 'BK', 'BK'], ['B33', 'B61', 'BL', 'BL']]
    ];
    // Groups have different pitch and vertical extents, matching the photographed board.
    const groups = [
        { id: 'G1', x: 70, y: 66, width: 242, height: 728, left: 105, right: 277, switchX: 190, ys: [126, 225, 324, 423, 522, 621, 720] },
        { id: 'G2', x: 319, y: 62, width: 239, height: 720, left: 355, right: 522, switchX: 439, ys: [122, 220, 318, 416, 514, 612, 710] },
        { id: 'G3', x: 566, y: 60, width: 233, height: 709, left: 603, right: 765, switchX: 685, ys: [118, 215, 312, 409, 506, 603, 700] },
        { id: 'G4', x: 807, y: 58, width: 241, height: 699, left: 844, right: 1013, switchX: 929, ys: [114, 210, 306, 402, 498] }
    ];
    const nodes = [];
    const switches = [];
    let sw = 1;
    groups.forEach((group, index) => {
        rows[index].forEach(([left, right, leftColor, rightColor], row) => {
            [[left, leftColor, group.left], [right, rightColor, group.right]].forEach(([label, color, x]) => {
                nodes.push({ id: `${group.id}-${label}`, label, color, x, y: group.ys[row], group: group.id, kind: 'Socket' });
            });
            switches.push({ label: `SW${sw++}`, x: group.switchX, y: group.ys[row] });
        });
    });
    nodes.push(
        { id: 'G4-SPECIAL-L', label: 'A48/B58/B6 (left)', color: 'BK', x: 844, y: 594, group: 'G4', kind: 'Socket', sharedLabel: true },
        { id: 'G4-SPECIAL-R', label: 'A48/B58/B6 (right)', color: 'BK', x: 1013, y: 594, group: 'G4', kind: 'Socket', sharedLabel: true },
        { id: 'G4-B37', label: 'B37', color: 'R', x: 844, y: 690, group: 'G4', kind: 'Power socket' },
        { id: 'G4-B55', label: 'B55', color: 'R', x: 1013, y: 690, group: 'G4', kind: 'Power socket' }
    );
    const template = {
        width: 1120, height: 820, groups, nodes, switches,
        colors: { W: 'White', BK: 'Black', BL: 'Blue', R: 'Red' },
        types: ['sensor', 'aod', 'physicalSwitch', 'mechanicalSwitch']
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = template;
    else root.BOX_TEMPLATE = template;
})(globalThis);
