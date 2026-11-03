(in-package #:quasar.store)

;; Rebuildable point/explicit-reference projection. Canonical documents and
;; workspace authorization remain authoritative. Only exported Tek9 APIs.
(defparameter +geo-depth+ 14)
(defparameter +geo-cell-budget+ 256)
(defparameter +geo-predicates+
  '("locatedAt" "located-at" "geolocated-at" "observedAt" "observed-at"
    "associatedWithPlace" "associated-with-place" "occupies"))

(dolist (code '("geo.invalid" "geo.index-required" "geo.zoom-in" "geo.index-collision"))
  (pushnew code quasar.protocol::+error-codes+ :test #'string=))

(defun %geo-prefix (workspace)
  (concatenate 'string (%workspace-prefix workspace) "geo/1/"))
(defun %geo-meta-key (workspace)
  (concatenate 'string (%geo-prefix workspace) "meta"))
(defun %geo-cell-key (workspace depth x y)
  (format nil "~Ac/~2,'0D/~5,'0D/~5,'0D" (%geo-prefix workspace) depth x y))
(defun %geo-point-prefix (workspace x y)
  (format nil "~Ap/~5,'0D/~5,'0D/" (%geo-prefix workspace) x y))
(defun %geo-link-prefix (workspace direction id)
  ;; Fixed-width lookup tokens avoid LMDB key overflow for canonical 512-char
  ;; IDs. Tokens are not identity or authority: reads match exact IDs and all
  ;; writes detect collisions atomically instead of overwriting another row.
  (format nil "~A~A/~A/" (%geo-prefix workspace) direction (%fnv1a-64 id)))

(defun %geo-decimal (value)
  "Bounded decimal parser, never the Lisp reader. Reject NaN, exponent and junk."
  (when (and (stringp value) (plusp (length value)))
    (let ((sign 1) (index 0) (whole 0) (fraction 0) (scale 1) (dot nil) (digits 0))
      (when (find (char value 0) "+-")
        (setf sign (if (char= (char value 0) #\-) -1 1) index 1))
      (loop for i from index below (length value)
            for char = (char value i)
            do (cond
                 ((and (char= char #\.) (not dot)) (setf dot t))
                 ((digit-char-p char)
                  (incf digits)
                  (if dot
                      ;; More decimal digits cannot improve display precision;
                      ;; validate them without building enormous bignums.
                      (when (< scale 1000000000000000000)
                        (setf fraction (+ (* fraction 10) (digit-char-p char)) scale (* scale 10)))
                      (progn
                        (setf whole (+ (* whole 10) (digit-char-p char)))
                        (when (> whole 180) (return-from %geo-decimal nil)))))
                 (t (return-from %geo-decimal nil))))
      (when (plusp digits) (* sign (+ (coerce whole 'double-float) (/ fraction (coerce scale 'double-float))))))))

(defun %geo-xy (longitude latitude depth)
  (let ((n (ash 1 depth)))
    (values (min (1- n) (max 0 (floor (* n (/ (+ longitude 180d0) 360d0)))))
            (min (1- n) (max 0 (floor (* n (/ (+ latitude 90d0) 180d0))))))))

(defun %geo-point (document)
  (when (and document
             (equal "0.10.1" (json-value document "schemaVersion"))
             (equal "geo-point" (json-value document "dtype"))
             (equal "point" (json-value document "geometryType"))
             (member (json-value document "coordinateReferenceSystem")
                     '(nil "EPSG:4326" "WGS84" "OGC:CRS84") :test #'equal))
    (let ((lon (%geo-decimal (json-value document "longitude")))
          (lat (%geo-decimal (json-value document "latitude"))))
      (when (and lon lat (<= -180d0 lon 180d0) (<= -90d0 lat 90d0))
        ;; +180 and -180 are the same meridian; retain one index location.
        (when (= lon 180d0) (setf lon -180d0))
        (quasar.protocol:json-object
         (cons "id" (json-value document "id"))
         (cons "dataset" (json-value document "dataset"))
         (cons "longitude" lon) (cons "latitude" lat)
         (cons "participationKind" "direct")
         (cons "geometrySource" "canonical-geo-point")
         (cons "accuracyMeters" (json-value document "accuracyMeters" :null))
         (cons "projectionOnly" t))))))

(defun %geo-reference-id (reference)
  (let ((schema (json-value reference "schema")) (id (json-value reference "id")))
    (when (and (stringp schema) (%prefix-p "org.starintel/core@1/" schema)
               (stringp id) (<= 1 (length id) 512))
      id)))

(defun %geo-document-links (document)
  "Allowlisted canonical references only; proximity is never a relation."
  (let ((id (json-value document "id")) (links nil))
    (when (and document (equal "0.10.1" (json-value document "schemaVersion")))
      (dolist (field '("geometry" "location"))
        (let ((target (%geo-reference-id (json-value document field))))
          (when target
            (push (quasar.protocol:json-object
                   (cons "source" id) (cons "target" target) (cons "via" id)
                   (cons "predicate" field) (cons "participationKind" "anchored")) links))))
      (when (and (equal "relation" (json-value document "dtype"))
                 (member (json-value document "predicate") +geo-predicates+ :test #'equal))
        (let ((source (%geo-reference-id (json-value document "source")))
              (target (%geo-reference-id (json-value document "destination"))))
          (when (and source target)
            (push (quasar.protocol:json-object
                   (cons "source" source) (cons "target" target) (cons "via" id)
                   (cons "predicate" (json-value document "predicate"))
                   (cons "participationKind" "anchored")) links)))))
    links))

(defun %geo-link-key (workspace direction link)
  (concatenate 'string
               (%geo-link-prefix workspace direction (json-value link (if (equal direction "in") "target" "source")))
               (%fnv1a-64 (json-value link "via")) "/" (%fnv1a-64 (json-value link "predicate"))))

(defun %geo-checked-put (database key value)
  (let ((old (tek9:fetch* database key)))
    (when (and old (not (equal old value)))
      (%query-error "geo.index-collision" "Geo lookup collision; canonical transaction was not committed."))
    (%put-record database key value)))

(defun %geo-adjust-point (database workspace point delta)
  (when point
    (loop for depth from 0 to +geo-depth+
          do (multiple-value-bind (x y) (%geo-xy (json-value point "longitude") (json-value point "latitude") depth)
               (let* ((key (%geo-cell-key workspace depth x y))
                      (old (tek9:fetch* database key))
                      (count (+ delta (json-value old "count" 0))))
                 (assert (>= count 0))
                 (if (zerop count)
                     (tek9:delete-document database key)
                     (%put-record database key (quasar.protocol:json-object (cons "count" count)))))))
    (multiple-value-bind (x y) (%geo-xy (json-value point "longitude") (json-value point "latitude") +geo-depth+)
      (let ((key (concatenate 'string (%geo-point-prefix workspace x y) (%fnv1a-64 (json-value point "id")))))
        (if (minusp delta) (tek9:delete-document database key) (%geo-checked-put database key point))))))

(defun %geo-change-projection (database workspace old new)
  (let ((before (%geo-point old)) (after (%geo-point new)))
    (unless (equal before after)
      (%geo-adjust-point database workspace before -1)
      (%geo-adjust-point database workspace after 1)))
  (dolist (link (%geo-document-links old))
    (dolist (direction '("in" "out"))
      (tek9:delete-document database (%geo-link-key workspace direction link))))
  (dolist (link (%geo-document-links new))
    (dolist (direction '("in" "out"))
      (%geo-checked-put database (%geo-link-key workspace direction link) link))))

(defun %geo-ready-p (database workspace)
  (eql 1 (json-value (tek9:fetch* database (%geo-meta-key workspace)) "version")))

(defun %geo-mark-ready (database workspace)
  (%put-record database (%geo-meta-key workspace) (quasar.protocol:json-object (cons "version" 1))))

(defun %geo-document-change (database workspace id new)
  ;; Called inside the canonical write transaction, before mutation. A legacy
  ;; nonempty workspace stays unavailable until an explicit atomic rebuild.
  (when (or (%geo-ready-p database workspace)
            (when (null (%bounded-range database (%document-prefix workspace) :limit 1))
              (%geo-mark-ready database workspace) t))
    (%geo-change-projection database workspace (tek9:fetch* database (%document-key workspace id)) new)))

(defun rebuild-geo-index (store workspace)
  "Explicit maintenance, not a map request. One atomic O(N) rebuild, O(batch) heap.
Blocks the writer for its duration. Use during a maintenance window for large stores."
  (unless (typep store 'tek9-store)
    (%query-error "query.unsupported-store" "Geo requires Tek9."))
  (let ((database (tek9-store-database store)) (count 0))
    (tek9:with-write-transaction (database)
      (%delete-prefix-bounded database (%geo-prefix workspace))
      (let ((start nil) (prefix (%document-prefix workspace)))
        (loop for rows = (%bounded-range database prefix :start start :limit 32)
              while rows
              do (dolist (row rows) (%geo-change-projection database workspace nil (cdr row)) (incf count))
                 (setf start (caar (last rows)))))
      (%geo-mark-ready database workspace))
    count))
