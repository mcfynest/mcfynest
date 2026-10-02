<?php
declare(strict_types=1);

if (!defined('MANIFEST_ENTRY')) {
    http_response_code(403);
    exit('Forbidden');
}

// Statuses that still count against a product's reserved quantity —
// i.e. the order hasn't reached a resolved end state yet. Delivered/
// Remitted have already deducted physical stock (see stock_deducted in
// orders.php) so they stop reserving; Cancelled/Returned never held stock
// in the first place under this model, so they never reserved either.
// (products.php keeps its own copy of this list.)
const RESERVING_STATUSES = ['pending', 'scheduled', 'transit', 'notpicking', 'issue'];

/** A rejected order-creation request; the message is safe to show the user. */
class OrderValidationException extends RuntimeException
{
    public int $httpStatus;

    public function __construct(string $message, int $httpStatus = 400)
    {
        parent::__construct($message);
        $this->httpStatus = $httpStatus;
    }
}

/** Quantity of a product reserved by orders that haven't reached a resolved end state yet. */
function product_reserved_qty(PDO $pdo, int $productId): int
{
    $placeholders = implode(',', array_fill(0, count(RESERVING_STATUSES), '?'));
    $stmt = $pdo->prepare("SELECT COALESCE(SUM(qty), 0) FROM orders WHERE product_id = ? AND deleted = 0 AND status IN ($placeholders)");
    $stmt->execute(array_merge([$productId], RESERVING_STATUSES));
    return (int) $stmt->fetchColumn();
}

/**
 * Creates a new order — the single place every order-creation rule
 * lives. Shared by the in-app "Add Order" form (api/orders.php) and the
 * Google Sheet import (api/sheet-import.php), so a new required field or
 * validation rule added here applies to both automatically.
 *
 * $input keys: product_id, customer, phone, alt_phone, address, zone,
 * notes, amount, qty. Strings are expected already trimmed.
 * amount may be null/absent (treated as 0); if present it must be a
 * number >= 0. qty must be a whole number >= 1.
 *
 * Returns ['order_code' => string, 'is_backorder' => bool].
 * Throws OrderValidationException for anything the caller should show
 * back to the user.
 */
function create_order(PDO $pdo, int $ownerRowId, int $placedByRowId, string $placedByName, array $input): array
{
    $productId = (int) ($input['product_id'] ?? 0);
    $customer = (string) ($input['customer'] ?? '');
    $phone = (string) ($input['phone'] ?? '');
    $altPhone = (string) ($input['alt_phone'] ?? '');
    $address = (string) ($input['address'] ?? '');
    $zone = (string) ($input['zone'] ?? '');
    $notes = (string) ($input['notes'] ?? '');
    $rawAmount = $input['amount'] ?? null;
    $rawQty = $input['qty'] ?? null;

    if ($productId <= 0 || $customer === '' || $phone === '' || $address === '') {
        throw new OrderValidationException('Fill in customer name, product, address and phone number.');
    }

    if (!is_numeric($rawQty) || (float) $rawQty != (int) $rawQty || (int) $rawQty < 1) {
        throw new OrderValidationException('Quantity must be a whole number of at least 1.');
    }
    $qty = (int) $rawQty;
    if ($qty > 100000) {
        throw new OrderValidationException('Quantity is too large.');
    }

    if ($rawAmount === null || $rawAmount === '') {
        $amount = 0.0;
    } elseif (!is_numeric($rawAmount) || (float) $rawAmount < 0) {
        throw new OrderValidationException('Amount must be a number of 0 or more (no currency symbols or commas), e.g. 33000.');
    } else {
        $amount = (float) $rawAmount;
    }
    if ($amount >= 100000000) {
        throw new OrderValidationException('Amount is too large.');
    }

    // Column limits — reject clearly rather than letting the database
    // error out (or silently truncate) on an over-long value.
    foreach ([
        ['Customer name', $customer, 255],
        ['Phone number', $phone, 50],
        ['Alternate phone', $altPhone, 50],
        ['Delivery zone', $zone, 120],
        ['Delivery address', $address, 2000],
        ['Notes', $notes, 2000],
    ] as [$label, $value, $max]) {
        if (mb_strlen($value) > $max) {
            throw new OrderValidationException("$label is too long (max $max characters).");
        }
    }

    $pdo->beginTransaction();
    try {
        // Placing an order never touches physical stock — it only counts
        // against the product's reserved quantity (see RESERVING_STATUSES).
        // The row lock here is still what makes "available" a consistent
        // read under concurrent order placement, same guarantee the old
        // qty-decrement had; we just no longer mutate qty at this point.
        $stmt = $pdo->prepare('SELECT id, name, qty FROM products WHERE id = ? AND store_id = ? AND deleted = 0 FOR UPDATE');
        $stmt->execute([$productId, $ownerRowId]);
        $product = $stmt->fetch();

        if (!$product) {
            throw new OrderValidationException('Product not found.', 404);
        }

        $available = max(0, (int) $product['qty'] - product_reserved_qty($pdo, $productId));

        // Backorders are explicitly allowed — never blocked server-side.
        // is_backorder is computed here (not trusted from the client) so
        // the badge is always accurate regardless of what the client sent.
        $isBackorder = $qty > $available;

        $orderCode = generate_order_code($pdo);
        $initialHistory = json_encode([['status' => 'pending', 'at' => date('Y-m-d H:i:s'), 'by' => $placedByName]]);
        $stmt = $pdo->prepare('INSERT INTO orders
            (order_code, store_id, placed_by_store_id, product_id, product_name, qty, customer_name, phone, alt_phone, delivery_address, zone, instructions, amount, is_backorder, status_history)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        $stmt->execute([
            $orderCode, $ownerRowId, $placedByRowId, $productId, $product['name'], $qty,
            $customer, $phone, $altPhone ?: null, $address, $zone ?: null, $notes, $amount, $isBackorder ? 1 : 0, $initialHistory,
        ]);

        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    return ['order_code' => $orderCode, 'is_backorder' => $isBackorder];
}

/**
 * Finds a store's inventory item by name: case-insensitive, ignoring
 * leading/trailing whitespace, otherwise an exact match — never fuzzy.
 * Returns the product id, or null if nothing matches.
 *
 * Each stock drop-off is logged as its own product row, so a store can
 * legitimately have several rows with the same name. In that case the
 * row with the most available stock wins (oldest row on a tie), so an
 * order is only flagged as a backorder when no single matching row can
 * cover it.
 */
function find_store_product_by_name(PDO $pdo, int $ownerRowId, string $name): ?int
{
    $wanted = mb_strtolower(trim($name));
    if ($wanted === '') {
        return null;
    }
    $stmt = $pdo->prepare('SELECT id, name, qty FROM products WHERE store_id = ? AND deleted = 0 ORDER BY id');
    $stmt->execute([$ownerRowId]);

    $bestId = null;
    $bestAvailable = PHP_INT_MIN;
    foreach ($stmt->fetchAll() as $p) {
        if (mb_strtolower(trim((string) $p['name'])) !== $wanted) {
            continue;
        }
        $available = (int) $p['qty'] - product_reserved_qty($pdo, (int) $p['id']);
        if ($available > $bestAvailable) {
            $bestAvailable = $available;
            $bestId = (int) $p['id'];
        }
    }
    return $bestId;
}

/** A new random Sheet API key (192 bits). Never derived from anything else. */
function generate_sheet_api_key(): string
{
    return 'mfs_' . bin2hex(random_bytes(24));
}

/** Shape check only — lets an obviously malformed key be rejected without a DB lookup. */
function is_sheet_api_key_format(string $key): bool
{
    return (bool) preg_match('/^mfs_[0-9a-f]{48}$/', $key);
}

/**
 * Returns an owner store's Sheet API key, generating and saving one on
 * first use. Only owner rows have a key — team-member logins don't.
 * Returns null if the row isn't an active owner store.
 */
function ensure_sheet_api_key(PDO $pdo, int $storeRowId): ?string
{
    $stmt = $pdo->prepare('SELECT sheet_api_key FROM stores WHERE id = ? AND role = "owner" AND is_active = 1');
    $stmt->execute([$storeRowId]);
    $row = $stmt->fetch();
    if (!$row) {
        return null;
    }
    if ($row['sheet_api_key']) {
        return $row['sheet_api_key'];
    }
    // "AND sheet_api_key IS NULL" so two simultaneous first reveals can't
    // each write a different key — whichever lands second is a no-op and
    // both re-read the winner below.
    $pdo->prepare('UPDATE stores SET sheet_api_key = ? WHERE id = ? AND sheet_api_key IS NULL')
        ->execute([generate_sheet_api_key(), $storeRowId]);
    $stmt->execute([$storeRowId]);
    return $stmt->fetchColumn() ?: null;
}

/** Replaces an owner store's Sheet API key; the old one stops working immediately. */
function regenerate_sheet_api_key(PDO $pdo, int $storeRowId): ?string
{
    $key = generate_sheet_api_key();
    $stmt = $pdo->prepare('UPDATE stores SET sheet_api_key = ? WHERE id = ? AND role = "owner" AND is_active = 1');
    $stmt->execute([$key, $storeRowId]);
    return $stmt->rowCount() > 0 ? $key : null;
}
