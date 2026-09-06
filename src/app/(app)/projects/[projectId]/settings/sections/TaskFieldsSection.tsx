"use client";

import { useState, type CSSProperties } from "react";
import { useApi } from "@/hooks/use-api";
import { useToast } from "@/components/ui/Toast";
import {
  ApiCustomField,
  ApiProjectCategory,
  ApiTaskTemplate,
  CATEGORIES,
  Category,
} from "@/types";
import { categoryColor } from "@/lib/category-colors";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Combobox } from "@/components/ui/Combobox";
import { CustomFieldEditor } from "./CustomFieldEditor";
import {
  CustomFieldForm,
  FieldDraft,
} from "@/components/settings/CustomFieldForm";
import { activeFields, sortedFields } from "@/lib/custom-fields";
import {
  SettingsCard,
  EmptyState,
  ListRow,
} from "@/components/settings/SettingsCard";
import { ListEditor } from "@/components/settings/ListEditor";
import { SettingRow } from "@/components/settings/SettingRow";
import { useDirtyGroup } from "@/components/settings/settings-context";
import { useDraft } from "@/hooks/use-draft";
import { Popover } from "@/components/ui/Popover";
import { SwatchPicker } from "@/components/ui/SwatchPicker";
import { categoryDiff, CategoryDraft } from "@/lib/category-diff";
import { diffById } from "@/lib/row-diff";
import { nextColour } from "@/lib/palette";
import { SectionProps } from "./types";

const ESTIMATE_FIELD_NAME = "Story points";

function estimateFieldHint(canAdmin: boolean, hasNumericField: boolean): string {
  const base = "Summed for sprint progress and velocity";
  if (hasNumericField) {
    return canAdmin ? base : `${base}. Only a project owner can change this.`;
  }
  return canAdmin
    ? `${base}. This project has no numeric field yet.`
    : `${base}. Only a project owner can create one.`;
}

export function TaskFieldsSection({
  projectId,
  project,
  patchProject,
  stats,
}: SectionProps) {
  const canDelete = !!project.canAdmin;
  const api = useApi();
  const { toast } = useToast();

  const numericFields = sortedFields(
    activeFields(project.customFields || []).filter((f) => f.fieldType === "number"),
  );
  const [creatingEstimateField, setCreatingEstimateField] = useState(false);

  const categories = useDraft<{ categories: CategoryDraft[] }>({
    categories: (project.categories || []).map((c) => ({
      _id: c._id,
      name: c.name,
      color: c.color,
    })),
  });
  const [fieldForm, setFieldForm] = useState<"new" | string | null>(null);
  const templates = useDraft<{ templates: ApiTaskTemplate[] }>({
    templates: project.taskTemplates || [],
  });
  const [expandedTemplate, setExpandedTemplate] = useState<string | null>(null);

  function fail(err: unknown, fallback: string) {
    toast(err instanceof Error ? err.message : fallback, "error");
  }

  useDirtyGroup(
    {
      id: "fields-categories",
      section: "fields",
      label: "Task fields · Categories",
      count: categories.count,
    },
    {
      save: async () => {
        const diff = categoryDiff(
          categories.baseline.categories,
          categories.value.categories,
        );
        let saved = project.categories || [];
        try {
          for (const change of diff.changed) {
            saved = await api.patch(
              `/api/projects/${projectId}/categories`,
              change,
            );
          }
          for (const added of diff.added) {
            saved = await api.post(
              `/api/projects/${projectId}/categories`,
              added,
            );
          }
          for (const name of diff.removed) {
            saved = await api.del(`/api/projects/${projectId}/categories`, {
              name,
            });
          }
          patchProject({ categories: saved });
          categories.commit({
            categories: saved.map((c) => ({
              _id: c._id,
              name: c.name,
              color: c.color,
            })),
          });
          toast("Categories saved", "success");
        } catch (err) {
          fail(err, "Failed to save categories");
          patchProject({ categories: saved });
          categories.rebase({
            categories: saved.map((c) => ({
              _id: c._id,
              name: c.name,
              color: c.color,
            })),
          });
        }
      },
      discard: categories.discard,
    },
  );

  useDirtyGroup(
    {
      id: "fields-templates",
      section: "fields",
      label: "Task fields · Templates",
      count: templates.count,
    },
    {
      save: async () => {
        const diff = diffById(
          templates.baseline.templates,
          templates.value.templates,
        );
        let saved = project.taskTemplates || [];
        try {
          for (const row of diff.added) {
            const { category, ...rest } = row;
            const live = categories.value.categories.some((c) => c.name === category);
            saved = await api.post(`/api/projects/${projectId}/templates`, {
              ...rest,
              ...(live ? { category } : {}),
            });
          }
          for (const row of diff.changed) {
            const live = categories.value.categories.some(
              (c) => c.name === row.category,
            );
            const { category, ...rest } = row;
            saved = await api.put(`/api/projects/${projectId}/templates`, {
              templateId: row._id,
              ...rest,
              ...(live ? { category } : {}),
            });
          }
          for (const templateId of diff.removed) {
            saved = await api.del(`/api/projects/${projectId}/templates`, {
              templateId,
            });
          }
          patchProject({ taskTemplates: saved });
          templates.commit({ templates: saved });
          toast("Templates saved", "success");
        } catch (err) {
          fail(err, "Failed to save templates");
          patchProject({ taskTemplates: saved });
          templates.rebase({ templates: saved });
        }
      },
      discard: templates.discard,
    },
  );

  async function addCustomField(draft: FieldDraft) {
    const customFields: ApiCustomField[] = await api.post(
      `/api/projects/${projectId}/custom-fields`,
      draft,
    );
    patchProject({ customFields });
    setFieldForm(null);
  }

  async function saveCustomField(
    fieldId: string,
    patch: FieldDraft | Record<string, unknown>,
  ) {
    const customFields: ApiCustomField[] = await api.patch(
      `/api/projects/${projectId}/custom-fields/${fieldId}`,
      patch,
    );
    const nowArchived = customFields.find((f) => f._id === fieldId)?.archived;
    patchProject(
      nowArchived && project.estimateFieldId === fieldId
        ? { customFields, estimateFieldId: "" }
        : { customFields },
    );
    setFieldForm(null);
  }

  async function removeCustomField(fieldId: string) {
    try {
      const customFields: ApiCustomField[] = await api.del(
        `/api/projects/${projectId}/custom-fields/${fieldId}`,
      );
      patchProject(
        project.estimateFieldId === fieldId
          ? { customFields, estimateFieldId: "" }
          : { customFields },
      );
    } catch (err) {
      fail(err, "Failed to remove custom field");
    }
  }

  async function designateEstimateField(fieldId: string) {
    try {
      await api.put(`/api/projects/${projectId}`, { estimateFieldId: fieldId });
      patchProject({ estimateFieldId: fieldId });
    } catch (err) {
      fail(err, "Failed to save estimate field");
    }
  }

  async function createEstimateField() {
    setCreatingEstimateField(true);
    try {
      const fields: ApiCustomField[] = await api.post(
        `/api/projects/${projectId}/custom-fields`,
        { name: ESTIMATE_FIELD_NAME, fieldType: "number" },
      );
      patchProject({ customFields: fields });
      const created = fields.find(
        (f) => f.fieldType === "number" && f.name === ESTIMATE_FIELD_NAME,
      );
      if (created) await designateEstimateField(created._id);
    } catch (err) {
      fail(err, `Failed to create "${ESTIMATE_FIELD_NAME}"`);
    } finally {
      setCreatingEstimateField(false);
    }
  }

  function editTemplate(index: number, patch: Partial<ApiTaskTemplate>) {
    templates.set(
      "templates",
      templates.value.templates.map((t, i) =>
        i === index ? { ...t, ...patch } : t,
      ),
    );
  }

  return (
    <>
      <SettingsCard
        title="Categories"
        description="The kind of work a task is. A category in use by tasks can't be removed."
      >
        <ListEditor
          items={categories.value.categories}
          onChange={(next) => categories.set("categories", next)}
          keyOf={(c, i) => c._id ?? `new-${i}`}
          nameOf={(c) => c.name || "this category"}
          reorderable={false}
          addLabel="Add category"
          canRemove={(c) =>
            (canDelete || !c._id) && categories.value.categories.length > 1
          }
          onAdd={() =>
            categories.set("categories", [
              ...categories.value.categories,
              {
                name: "",
                color: nextColour(
                  categories.value.categories.map((c) => c.color),
                ),
              },
            ])
          }
          empty={
            <EmptyState>
              No categories yet. Add one to describe what kind of work a task
              is.
            </EmptyState>
          }
          renderRow={(cat, i) => (
            <>
              <div className="min-w-0 flex-1 sm:w-[240px] sm:flex-none sm:shrink-0">
                <Input
                  value={cat.name}
                  aria-label="Category name"
                  placeholder="Category name..."
                  className="py-1.5"
                  onChange={(e) =>
                    categories.set(
                      "categories",
                      categories.value.categories.map((c, idx) =>
                        idx === i ? { ...c, name: e.target.value } : c,
                      ),
                    )
                  }
                />
              </div>
              <Popover
                width="w-auto"
                trigger={({ toggle }) => (
                  <button
                    type="button"
                    onClick={toggle}
                    aria-label={`Colour for ${cat.name || "this category"}`}
                    className="focus-ring h-11 w-11 shrink-0 rounded-lg border border-border sm:h-9 sm:w-9"
                    style={{ backgroundColor: cat.color }}
                  />
                )}
              >
                {({ close }) => (
                  <div className="p-2">
                    <SwatchPicker
                      value={cat.color}
                      label={`Colour for ${cat.name || "this category"}`}
                      onChange={(hex) => {
                        categories.set(
                          "categories",
                          categories.value.categories.map((c, idx) =>
                            idx === i ? { ...c, color: hex } : c,
                          ),
                        );
                        close();
                      }}
                    />
                  </div>
                )}
              </Popover>
            </>
          )}
        />
      </SettingsCard>

      <SettingsCard
        title="Custom fields"
        description="Extra fields carried by every task in this project. Archived fields keep the values already on tasks and stop appearing in pickers."
      >
        <div className="space-y-2">
          {sortedFields(project.customFields || []).map((field) =>
            fieldForm === field._id ? (
              <CustomFieldForm
                key={field._id}
                field={field}
                onSubmit={(draft) => saveCustomField(field._id, draft)}
                onCancel={() => setFieldForm(null)}
              />
            ) : (
              <CustomFieldEditor
                key={field._id}
                field={field}
                onEdit={() => setFieldForm(field._id)}
                onSave={(patch) => saveCustomField(field._id, patch)}
                onDelete={() => removeCustomField(field._id)}
                usage={
                  stats?.customFieldUsage[field._id] ?? (stats ? 0 : undefined)
                }
                canDelete={canDelete}
              />
            ),
          )}
          {(project.customFields || []).length === 0 && fieldForm !== "new" && (
            <EmptyState>
              No custom fields yet. Add one to capture something the built-in
              fields don&apos;t.
            </EmptyState>
          )}
        </div>

        {fieldForm === "new" ? (
          <CustomFieldForm
            onSubmit={addCustomField}
            onCancel={() => setFieldForm(null)}
          />
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setFieldForm("new")}
          >
            + Add field
          </Button>
        )}
      </SettingsCard>

      <SettingsCard
        title="Sprint estimates"
        description="Which field on a task is its size."
      >
        {numericFields.length === 0 ? (
          <SettingRow
            label="Estimate field"
            hint={estimateFieldHint(!!project.canAdmin, false)}
          >
            <Button
              variant="secondary"
              size="sm"
              disabled={!project.canAdmin || creatingEstimateField}
              onClick={createEstimateField}
            >
              {creatingEstimateField ? "Creating..." : `Create "${ESTIMATE_FIELD_NAME}"`}
            </Button>
          </SettingRow>
        ) : (
          <SettingRow
            label="Estimate field"
            hint={estimateFieldHint(!!project.canAdmin, true)}
          >
            <Select
              aria-label="Estimate field"
              value={project.estimateFieldId}
              disabled={!project.canAdmin}
              options={[
                { value: "", label: "None" },
                ...numericFields.map((f) => ({ value: f._id, label: f.name })),
              ]}
              onChange={(e) => designateEstimateField(e.target.value)}
            />
          </SettingRow>
        )}
      </SettingsCard>

      <SettingsCard
        title="Task templates"
        description="Pre-filled starting points for tasks people create often."
      >
        <ListEditor
          items={templates.value.templates}
          onChange={(next) => templates.set("templates", next)}
          keyOf={(t, i) => t._id || `new-${i}`}
          nameOf={(t) => t.name || "this template"}
          canRemove={(t) => canDelete || !t._id}
          reorderable={false}
          addLabel="Add template"
          onAdd={() =>
            templates.set("templates", [
              ...templates.value.templates,
              {
                _id: "",
                name: "",
                title: "",
                description: "",
                category: categories.value.categories[0]?.name ?? CATEGORIES[0],
                acceptanceCriteria: "",
              } as ApiTaskTemplate,
            ])
          }
          empty={
            <EmptyState>
              Add a template to skip filling in the same fields every time.
            </EmptyState>
          }
          renderRow={(tpl, i) => {
            const key = tpl._id || `new-${i}`;
            const open = expandedTemplate === key;
            return (
              <>
                <div className="min-w-0 flex-1 sm:w-[220px] sm:flex-none sm:shrink-0">
                  <Input
                    value={tpl.name}
                    aria-label="Template name"
                    placeholder="Template name..."
                    className="py-1.5"
                    onChange={(e) => editTemplate(i, { name: e.target.value })}
                  />
                </div>
                {tpl.category && (
                  <span
                    className="chip chip-custom rounded px-2 py-0.5 text-xs"
                    style={
                      {
                        "--chip":
                          categoryColor(
                            categories.value.categories as ApiProjectCategory[],
                            tpl.category,
                          ) || "var(--color-text-muted)",
                      } as CSSProperties
                    }
                  >
                    {tpl.category}
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setExpandedTemplate(open ? null : key)}
                >
                  {open ? "Done" : "Edit"}
                </Button>
                {open && (
                  <div className="w-full space-y-3 pt-2">
                    <Input
                      label="Title template"
                      value={tpl.title}
                      placeholder="Pre-filled title"
                      onChange={(e) =>
                        editTemplate(i, { title: e.target.value })
                      }
                    />
                    <div>
                      <label className="mb-1 block text-sm font-medium text-text-muted">
                        Category
                      </label>
                      <Combobox
                        label="Template category"
                        value={tpl.category}
                        options={
                          categories.value.categories.length > 0
                            ? categories.value.categories.map((c) => ({
                                value: c.name,
                                label: c.name,
                                color: c.color,
                              }))
                            : CATEGORIES.map((c) => ({ value: c, label: c }))
                        }
                        onChange={(value) =>
                          editTemplate(i, { category: value as Category })
                        }
                        triggerClassName="w-full rounded-lg border border-border bg-bg-input px-3 py-2 text-left text-sm"
                      >
                        {(selected) => (
                          <span className="flex items-center gap-2">
                            {selected?.color && (
                              <span
                                aria-hidden
                                className="h-2 w-2 shrink-0 rounded-full"
                                style={{ backgroundColor: selected.color }}
                              />
                            )}
                            {selected?.label || tpl.category}
                          </span>
                        )}
                      </Combobox>
                    </div>
                    <Textarea
                      label="Description"
                      value={tpl.description}
                      rows={3}
                      onChange={(e) =>
                        editTemplate(i, { description: e.target.value })
                      }
                    />
                    <Textarea
                      label="Acceptance Criteria"
                      value={tpl.acceptanceCriteria}
                      rows={3}
                      onChange={(e) =>
                        editTemplate(i, { acceptanceCriteria: e.target.value })
                      }
                    />
                  </div>
                )}
              </>
            );
          }}
        />
      </SettingsCard>
    </>
  );
}
