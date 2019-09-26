import BasePlugin from './../_base';
import Hooks from './../../pluginHooks';
import { arrayReduce } from './../../helpers/array';
import { addClass, removeClass, offset } from './../../helpers/dom/element';
import { rangeEach } from './../../helpers/number';
import EventManager from './../../eventManager';
import { registerPlugin } from './../../plugins';
import BacklightUI from './ui/backlight';
import GuidelineUI from './ui/guideline';

import './manualRowMove.css';

Hooks.getSingleton().register('beforeRowMove');
Hooks.getSingleton().register('afterRowMove');

const privatePool = new WeakMap();
const CSS_PLUGIN = 'ht__manualRowMove';
const CSS_SHOW_UI = 'show-ui';
const CSS_ON_MOVING = 'on-moving--rows';
const CSS_AFTER_SELECTION = 'after-selection--rows';

/**
 * @plugin ManualRowMove
 *
 * @description
 * This plugin allows to change rows order. To make rows order persistent the {@link Options#persistentState}
 * plugin should be enabled.
 *
 * API:
 * - `moveRow` - move single row to the new position.
 * - `moveRows` - move many rows (as an array of indexes) to the new position.
 * - `dragRow` - drag single row to the new position.
 * - `dragRows` - drag many rows (as an array of indexes) to the new position.
 *
 * [Documentation](/demo-moving.html#manualRowMove) explain differences between drag and move actions. Please keep in mind that if you want apply visual changes,
 * you have to call manually the `render` method on the instance of Handsontable.
 *
 * The plugin creates additional components to make moving possibly using user interface:
 * - backlight - highlight of selected rows.
 * - guideline - line which shows where rows has been moved.
 *
 * @class ManualRowMove
 * @plugin ManualRowMove
 */
class ManualRowMove extends BasePlugin {
  constructor(hotInstance) {
    super(hotInstance);

    /**
     * Set up WeakMap of plugin to sharing private parameters;
     */
    privatePool.set(this, {
      rowsToMove: [],
      pressed: void 0,
      target: {
        eventPageY: void 0,
        coords: void 0,
        TD: void 0,
        row: void 0
      },
      cachedDropIndex: void 0
    });

    /**
     * Event Manager object.
     *
     * @private
     * @type {Object}
     */
    this.eventManager = new EventManager(this);
    /**
     * Backlight UI object.
     *
     * @private
     * @type {Object}
     */
    this.backlight = new BacklightUI(hotInstance);
    /**
     * Guideline UI object.
     *
     * @private
     * @type {Object}
     */
    this.guideline = new GuidelineUI(hotInstance);
  }

  /**
   * Checks if the plugin is enabled in the handsontable settings. This method is executed in {@link Hooks#beforeInit}
   * hook and if it returns `true` than the {@link ManualRowMove#enablePlugin} method is called.
   *
   * @returns {Boolean}
   */
  isEnabled() {
    return !!this.hot.getSettings().manualRowMove;
  }

  /**
   * Enables the plugin functionality for this Handsontable instance.
   */
  enablePlugin() {
    if (this.enabled) {
      return;
    }

    this.addHook('beforeOnCellMouseDown', (event, coords, TD, blockCalculations) => this.onBeforeOnCellMouseDown(event, coords, TD, blockCalculations));
    this.addHook('beforeOnCellMouseOver', (event, coords, TD, blockCalculations) => this.onBeforeOnCellMouseOver(event, coords, TD, blockCalculations));
    this.addHook('afterScrollHorizontally', () => this.onAfterScrollHorizontally());
    this.addHook('afterLoadData', () => this.onAfterLoadData());

    this.buildPluginUI();
    this.registerEvents();

    // TODO: move adding plugin classname to BasePlugin.
    addClass(this.hot.rootElement, CSS_PLUGIN);

    super.enablePlugin();
  }

  /**
   * Updates the plugin state. This method is executed when {@link Core#updateSettings} is invoked.
   */
  updatePlugin() {
    this.disablePlugin();
    this.enablePlugin();

    this.moveBySettingsOrLoad();

    super.updatePlugin();
  }

  /**
   * Disables the plugin functionality for this Handsontable instance.
   */
  disablePlugin() {
    removeClass(this.hot.rootElement, CSS_PLUGIN);

    this.unregisterEvents();
    this.backlight.destroy();
    this.guideline.destroy();

    super.disablePlugin();
  }

  /**
   * Moves a single row.
   *
   * @param {Number} row Visual row index to be moved.
   * @param {Number} finalIndex Visual row index, being a start index for the moved rows. Points to where the elements will be placed after the moving action.
   * To check the visualization of the final index, please take a look at [documentation](/demo-moving.html#manualRowMove).
   * @fires Hooks#beforeRowMove
   * @fires Hooks#afterRowMove
   */
  moveRow(row, finalIndex) {
    this.moveRows([row], finalIndex);
  }

  /**
   * Moves a multiple rows.
   *
   * @param {Array} rows Array of visual row indexes to be moved.
   * @param {Number} finalIndex Visual row index, being a start index for the moved rows. Points to where the elements will be placed after the moving action.
   * To check the visualization of the final index, please take a look at [documentation](/demo-moving.html#manualRowMove).
   * @fires Hooks#beforeRowMove
   * @fires Hooks#afterRowMove
   */
  moveRows(rows, finalIndex) {
    const priv = privatePool.get(this);
    const dropIndex = priv.cachedDropIndex;
    const movePossible = this.isMovePossible(rows, finalIndex);
    const beforeMoveHook = this.hot.runHooks('beforeRowMove', rows, finalIndex, dropIndex, movePossible);

    priv.cachedDropIndex = void 0;

    if (beforeMoveHook === false) {
      return;
    }

    if (movePossible) {
      this.rowIndexMapper.moveIndexes(rows, finalIndex);
    }

    this.hot.runHooks('afterRowMove', rows, finalIndex, dropIndex, movePossible, movePossible && this.isRowOrderChanged(rows, finalIndex));
  }

  /**
   * Drag a single row to drop index position.
   *
   * @param {Number} row Visual row index to be dragged.
   * @param {Number} dropIndex Visual row index, being a drop index for the moved rows. Points to where we are going to drop the moved elements.
   * To check visualization of drop index please take a look at [documentation](/demo-moving.html#manualRowMove).
   */
  dragRow(row, dropIndex) {
    this.dragRows([row], dropIndex);
  }

  /**
   * Drag multiple rows to drop index position.
   *
   * @param {Array} rows Array of visual row indexes to be dragged.
   * @param {Number} dropIndex Visual row index, being a drop index for the moved rows. Points to where we are going to drop the moved elements.
   * To check visualization of drop index please take a look at [documentation](/demo-moving.html#manualRowMove).
   */
  dragRows(rows, dropIndex) {
    const finalIndex = this.countFinalIndex(rows, dropIndex);
    const priv = privatePool.get(this);

    priv.cachedDropIndex = dropIndex;

    this.moveRows(rows, finalIndex);
  }

  /**
   * Indicates if it's possible to move rows to the desired position. Some of the actions aren't possible, i.e. you can’t move more than one element to the last position.
   *
   * @param {Array} movedRows Array of visual row indexes to be moved.
   * @param {Number} finalIndex Visual row index, being a start index for the moved rows. Points to where the elements will be placed after the moving action.
   * To check the visualization of the final index, please take a look at [documentation](/demo-moving.html#manualRowMove).
   * @returns {Boolean}
   */
  isMovePossible(movedRows, finalIndex) {
    const length = this.rowIndexMapper.getNotSkippedIndexesLength();

    // An attempt to transfer more rows to start destination than is possible (only when moving from the top to the bottom).
    const tooHighDestinationIndex = movedRows.length + finalIndex > length;

    const tooLowDestinationIndex = finalIndex < 0;
    const tooLowMovedRowIndex = movedRows.some(movedRow => movedRow < 0);
    const tooHighMovedRowIndex = movedRows.some(movedRow => movedRow >= length);

    if (tooHighDestinationIndex || tooLowDestinationIndex || tooLowMovedRowIndex || tooHighMovedRowIndex) {
      return false;
    }

    return true;
  }

  /**
   * Indicates if order of rows was changed.
   *
   * @private
   * @param {Array} movedRows Array of visual row indexes to be moved.
   * @param {Number} finalIndex Visual row index, being a start index for the moved rows. Points to where the elements will be placed after the moving action.
   * To check the visualization of the final index, please take a look at [documentation](/demo-moving.html#manualRowMove).
   * @returns {Boolean}
   */
  isRowOrderChanged(movedRows, finalIndex) {
    return movedRows.some((row, nrOfMovedElement) => row - nrOfMovedElement !== finalIndex);
  }

  /**
   * Count the final row index from the drop index.
   *
   * @private
   * @param {Array} movedRows Array of visual row indexes to be moved.
   * @param {Number} dropIndex Visual row index, being a drop index for the moved rows.
   * @returns {Number} Visual row index, being a start index for the moved rows.
   */
  countFinalIndex(movedRows, dropIndex) {
    const numberOfRowsLowerThanDropIndex = arrayReduce(movedRows, (numberOfRows, currentRowIndex) => {
      if (currentRowIndex < dropIndex) {
        numberOfRows += 1;
      }

      return numberOfRows;
    }, 0);

    return dropIndex - numberOfRowsLowerThanDropIndex;
  }

  /**
   * Correct the cell selection after the move action. Fired only when action was made with a mouse.
   * That means that changing the row order using the API won't correct the selection.
   *
   * @private
   * @param {Number} startRow Visual row index for the start of the selection.
   * @param {Number} endRow Visual row index for the end of the selection.
   */
  changeSelection(startRow, endRow) {
    this.hot.selectRows(startRow, endRow);
  }

  /**
   * Gets the sum of the heights of rows in the provided range.
   *
   * @private
   * @param {Number} from Visual row index.
   * @param {Number} to Visual row index.
   * @returns {Number}
   */
  getRowsHeight(from, to) {
    let height = 0;

    for (let i = from; i < to; i++) {
      const rowHeight = this.hot.view.wt.wtTable.getRowHeight(i) || 23;

      height += rowHeight;
    }

    return height;
  }

  /**
   * Loads initial settings when persistent state is saved or when plugin was initialized as an array.
   *
   * @private
   */
  moveBySettingsOrLoad() {
    const pluginSettings = this.hot.getSettings().manualRowMove;

    if (Array.isArray(pluginSettings)) {
      this.moveRows(pluginSettings, 0);

    } else if (pluginSettings !== void 0) {
      const persistentState = this.persistentStateLoad();

      if (persistentState.length) {
        this.moveRows(persistentState, 0);
      }
    }
  }

  /**
   * Checks if the provided row is in the fixedRowsTop section.
   *
   * @private
   * @param {Number} row Visual row index to check.
   * @returns {Boolean}
   */
  isFixedRowTop(row) {
    return row < this.hot.getSettings().fixedRowsTop;
  }

  /**
   * Checks if the provided row is in the fixedRowsBottom section.
   *
   * @private
   * @param {Number} row Visual row index to check.
   * @returns {Boolean}
   */
  isFixedRowBottom(row) {
    return row > this.hot.getSettings().fixedRowsBottom;
  }

  /**
   * Saves the manual row positions to the persistent state (the {@link Options#persistentState} option has to be enabled).
   *
   * @private
   * @fires Hooks#persistentStateSave
   */
  persistentStateSave() {
    this.hot.runHooks('persistentStateSave', 'manualRowMove', this.rowIndexMapper.getIndexesSequence()); // The `PersistentState` plugin should be refactored.
  }

  /**
   * Loads the manual row positions from the persistent state (the {@link Options#persistentState} option has to be enabled).
   *
   * @private
   * @fires Hooks#persistentStateLoad
   * @returns {Array} Stored state.
   */
  persistentStateLoad() {
    const storedState = {};

    this.hot.runHooks('persistentStateLoad', 'manualRowMove', storedState);

    return storedState.value ? storedState.value : [];
  }

  /**
   * Prepares an array of indexes based on actual selection.
   *
   * @private
   * @returns {Array}
   */
  prepareRowsToMoving() {
    const selection = this.hot.getSelectedRangeLast();
    const selectedRows = [];

    if (!selection) {
      return selectedRows;
    }

    const { from, to } = selection;
    const start = Math.min(from.row, to.row);
    const end = Math.max(from.row, to.row);

    rangeEach(start, end, (i) => {
      selectedRows.push(i);
    });

    return selectedRows;
  }

  /**
   * Update the UI visual position.
   *
   * @private
   */
  refreshPositions() {
    const priv = privatePool.get(this);
    const coords = priv.target.coords;
    const firstVisible = this.hot.view.wt.wtTable.getFirstVisibleRow();
    const lastVisible = this.hot.view.wt.wtTable.getLastVisibleRow();
    const fixedRows = this.hot.getSettings().fixedRowsTop;
    const countRows = this.hot.countRows();

    if (coords.row < fixedRows && firstVisible > 0) {
      this.hot.scrollViewportTo(firstVisible - 1);
    }
    if (coords.row >= lastVisible && lastVisible < countRows) {
      this.hot.scrollViewportTo(lastVisible + 1, undefined, true);
    }

    const wtTable = this.hot.view.wt.wtTable;
    const TD = priv.target.TD;
    const rootElementOffset = offset(this.hot.rootElement);
    let tdOffsetTop = this.hot.view.THEAD.offsetHeight + this.getRowsHeight(0, coords.row);
    const mouseOffsetTop = priv.target.eventPageY - rootElementOffset.top + wtTable.holder.scrollTop;
    const hiderHeight = wtTable.hider.offsetHeight;
    const tbodyOffsetTop = wtTable.TBODY.offsetTop;
    const backlightElemMarginTop = this.backlight.getOffset().top;
    const backlightElemHeight = this.backlight.getSize().height;

    if (this.isFixedRowTop(coords.row)) {
      tdOffsetTop += wtTable.holder.scrollTop;
    }

    // todo: fixedRowsBottom
    // if (this.isFixedRowBottom(coords.row)) {
    //
    // }

    if (coords.row < 0) {
      // if hover on colHeader
      priv.target.row = firstVisible > 0 ? firstVisible - 1 : firstVisible;
    } else if ((TD.offsetHeight / 2) + tdOffsetTop <= mouseOffsetTop) {
      // if hover on lower part of TD
      priv.target.row = coords.row + 1;
      // unfortunately first row is bigger than rest
      tdOffsetTop += coords.row === 0 ? TD.offsetHeight - 1 : TD.offsetHeight;

    } else {
      // elsewhere on table
      priv.target.row = coords.row;
    }

    let backlightTop = mouseOffsetTop;
    let guidelineTop = tdOffsetTop;

    if (mouseOffsetTop + backlightElemHeight + backlightElemMarginTop >= hiderHeight) {
      // prevent display backlight below table
      backlightTop = hiderHeight - backlightElemHeight - backlightElemMarginTop;

    } else if (mouseOffsetTop + backlightElemMarginTop < tbodyOffsetTop) {
      // prevent display above below table
      backlightTop = tbodyOffsetTop + Math.abs(backlightElemMarginTop);
    }

    if (tdOffsetTop >= hiderHeight - 1) {
      // prevent display guideline below table
      guidelineTop = hiderHeight - 1;
    }

    let topOverlayHeight = 0;
    if (this.hot.view.wt.wtOverlays.topOverlay) {
      topOverlayHeight = this.hot.view.wt.wtOverlays.topOverlay.clone.wtTable.TABLE.offsetHeight;
    }

    if (coords.row >= fixedRows && (guidelineTop - wtTable.holder.scrollTop) < topOverlayHeight) {
      this.hot.scrollViewportTo(coords.row);
    }

    this.backlight.setPosition(backlightTop);
    this.guideline.setPosition(guidelineTop);
  }

  /**
   * Binds the events used by the plugin.
   *
   * @private
   */
  registerEvents() {
    const { documentElement } = this.hot.rootDocument;

    this.eventManager.addEventListener(documentElement, 'mousemove', event => this.onMouseMove(event));
    this.eventManager.addEventListener(documentElement, 'mouseup', () => this.onMouseUp());
  }

  /**
   * Unbinds the events used by the plugin.
   *
   * @private
   */
  unregisterEvents() {
    this.eventManager.clear();
  }

  /**
   * Change the behavior of selection / dragging.
   *
   * @private
   * @param {MouseEvent} event `mousedown` event properties.
   * @param {CellCoords} coords Visual cell coordinates where was fired event.
   * @param {HTMLElement} TD Cell represented as HTMLElement.
   * @param {Object} blockCalculations Object which contains information about blockCalculation for row, column or cells.
   */
  onBeforeOnCellMouseDown(event, coords, TD, blockCalculations) {
    const { wtTable, wtViewport } = this.hot.view.wt;
    const isHeaderSelection = this.hot.selection.isSelectedByRowHeader();
    const selection = this.hot.getSelectedRangeLast();
    const priv = privatePool.get(this);

    if (!selection || !isHeaderSelection || priv.pressed || event.button !== 0) {
      priv.pressed = false;
      priv.rowsToMove.length = 0;
      removeClass(this.hot.rootElement, [CSS_ON_MOVING, CSS_SHOW_UI]);
      return;
    }

    const guidelineIsNotReady = this.guideline.isBuilt() && !this.guideline.isAppended();
    const backlightIsNotReady = this.backlight.isBuilt() && !this.backlight.isAppended();

    if (guidelineIsNotReady && backlightIsNotReady) {
      this.guideline.appendTo(wtTable.hider);
      this.backlight.appendTo(wtTable.hider);
    }

    const { from, to } = selection;
    const start = Math.min(from.row, to.row);
    const end = Math.max(from.row, to.row);

    if (coords.col < 0 && (coords.row >= start && coords.row <= end)) {
      blockCalculations.row = true;
      priv.pressed = true;
      priv.target.eventPageY = event.pageY;
      priv.target.coords = coords;
      priv.target.TD = TD;
      priv.rowsToMove = this.prepareRowsToMoving();

      const leftPos = wtTable.holder.scrollLeft + wtViewport.getRowHeaderWidth();

      this.backlight.setPosition(null, leftPos);
      this.backlight.setSize(wtTable.hider.offsetWidth - leftPos, this.getRowsHeight(start, end + 1));
      this.backlight.setOffset((this.getRowsHeight(start, coords.row) + event.layerY) * -1, null);

      addClass(this.hot.rootElement, CSS_ON_MOVING);

      this.refreshPositions();

    } else {
      removeClass(this.hot.rootElement, CSS_AFTER_SELECTION);
      priv.pressed = false;
      priv.rowsToMove.length = 0;
    }
  }

  /**
   * 'mouseMove' event callback. Fired when pointer move on document.documentElement.
   *
   * @private
   * @param {MouseEvent} event `mousemove` event properties.
   */
  onMouseMove(event) {
    const priv = privatePool.get(this);

    if (!priv.pressed) {
      return;
    }

    // callback for browser which doesn't supports CSS pointer-event: none
    if (event.realTarget === this.backlight.element) {
      const height = this.backlight.getSize().height;
      this.backlight.setSize(null, 0);

      setTimeout(function() {
        this.backlight.setPosition(null, height);
      });
    }

    priv.target.eventPageY = event.pageY;
    this.refreshPositions();
  }

  /**
   * 'beforeOnCellMouseOver' hook callback. Fired when pointer was over cell.
   *
   * @private
   * @param {MouseEvent} event `mouseover` event properties.
   * @param {CellCoords} coords Visual cell coordinates where was fired event.
   * @param {HTMLElement} TD Cell represented as HTMLElement.
   * @param {Object} blockCalculations Object which contains information about blockCalculation for row, column or cells.
   */
  onBeforeOnCellMouseOver(event, coords, TD, blockCalculations) {
    const selectedRange = this.hot.getSelectedRangeLast();
    const priv = privatePool.get(this);

    if (!selectedRange || !priv.pressed) {
      return;
    }

    if (priv.rowsToMove.indexOf(coords.row) > -1) {
      removeClass(this.hot.rootElement, CSS_SHOW_UI);

    } else {
      addClass(this.hot.rootElement, CSS_SHOW_UI);
    }

    blockCalculations.row = true;
    blockCalculations.column = true;
    blockCalculations.cell = true;
    priv.target.coords = coords;
    priv.target.TD = TD;
  }

  /**
   * `onMouseUp` hook callback.
   *
   * @private
   */
  onMouseUp() {
    const priv = privatePool.get(this);
    const target = priv.target.row;
    const rowsLen = priv.rowsToMove.length;

    priv.pressed = false;
    priv.backlightHeight = 0;

    removeClass(this.hot.rootElement, [CSS_ON_MOVING, CSS_SHOW_UI, CSS_AFTER_SELECTION]);

    if (this.hot.selection.isSelectedByRowHeader()) {
      addClass(this.hot.rootElement, CSS_AFTER_SELECTION);
    }

    if (rowsLen < 1 || target === void 0) {
      return;
    }

    const firstMovedVisualRow = priv.rowsToMove[0];
    const firstMovedPhysicalRow = this.t.toPhysicalRow(firstMovedVisualRow);

    this.dragRows(priv.rowsToMove, target);

    this.persistentStateSave();
    this.hot.render();

    const selectionStart = this.t.toVisualRow(firstMovedPhysicalRow);
    const selectionEnd = selectionStart + rowsLen - 1;

    this.changeSelection(selectionStart, selectionEnd);

    priv.rowsToMove.length = 0;
  }

  /**
   * `afterScrollHorizontally` hook callback. Fired the table was scrolled horizontally.
   *
   * @private
   */
  onAfterScrollHorizontally() {
    const wtTable = this.hot.view.wt.wtTable;
    const headerWidth = this.hot.view.wt.wtViewport.getRowHeaderWidth();
    const scrollLeft = wtTable.holder.scrollLeft;
    const posLeft = headerWidth + scrollLeft;

    this.backlight.setPosition(null, posLeft);
    this.backlight.setSize(wtTable.hider.offsetWidth - posLeft);
  }

  /**
   * Builds the plugin's UI.
   *
   * @private
   */
  buildPluginUI() {
    this.backlight.build();
    this.guideline.build();
  }

  /**
   * Callback for the `afterLoadData` hook.
   *
   * @private
   */
  onAfterLoadData() {
    this.moveBySettingsOrLoad();
  }

  /**
   * Destroys the plugin instance.
   */
  destroy() {
    this.backlight.destroy();
    this.guideline.destroy();

    super.destroy();
  }
}

registerPlugin('ManualRowMove', ManualRowMove);

export default ManualRowMove;
