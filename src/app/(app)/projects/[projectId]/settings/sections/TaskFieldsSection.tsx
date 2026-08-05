"use client";

import { useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useToast } from "@/components/ui/Toast";
import {
  ApiCustomField,
  ApiTaskTemplate,
  CUSTOM_FIELD_TYPES,
  CATEGORIES,
  Category,
  CustomFieldType,
} from "@/types";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Button } from "@/components/ui/Button";
import { CustomFieldEditor } from "./CustomFieldEditor";
import {
  CustomFieldForm,
  FieldDraft,
} from "@/components/settings/CustomFieldForm";
import { sortedFields } from "@/lib/custom-fields";
import {
  SettingsCard,
  EmptyState,
  ListRow,
} from "@/components/settings/SettingsCard";
import { ListEditor } from "@/components/settings/ListEditor";
import { useDirtyGroup } from "@/components/settings/settings-context";
import { useDraft } from "@/hooks/use-draft";
import { Popover } from "@/components/ui/Popover";
import { SwatchPicker } from "@/components/ui/SwatchPicker";
import { categoryDiff, CategoryDraft } from "@/lib/category-diff";
import { diffById } from "@/lib/row-diff";
import { nextColour } from "@/lib/palette";
import { SectionProps } from "./types";

export function TaskFieldsSection({
  projectId,
  project,
  patchProject,
  stats,
}: SectionProps) {
  // Deleting a category, field or template is admin-only on the server; offering the
  // control to a member stages a removal that only fails when the save runs
  const canDelete = !!project.canAdmin;
  const api = useApi();
  const { toast } = useToast();

  // Explicit, because a row added here has no _id until it is saved
  const categories = useDraft<{ categories: CategoryDraft[] }>({
    categories: (project.categories || []).map((c) => ({
      _id: c._id,
      name: c.name,
      color: c.color,
    })),
  });
  // "new" opens the create form; a field id opens the same form over that field
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
        try {
          let saved = project.categories || [];
          // Renames first: a name freed by a rename may be the one an added row wants,
          // and a removal checks the tasks still holding the old name
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
        try {
          let saved = project.taskTemplates || [];
          for (const row of diff.added) {
            saved = await api.post(`/api/projects/${projectId}/templates`, row);
          }
          for (const row of diff.changed) {
            // Categories may have been renamed by their own group in this same save, so a
            // name this draft still remembers can already be gone
            // The categories group may be saving renames in this same pass and `project` has
            // not caught up, so its own draft is where the new names are
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
        }
      },
      discard: templates.discard,
    },
  );

  // Throws rather than toasting: the form stays open on failure and shows the reason
  // beside the field, instead of closing and dropping what was typed
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
    patchProject({
      customFields: await api.patch(
        `/api/projects/${projectId}/custom-fields/${fieldId}`,
        patch,
      ),
    });
    setFieldForm(null);
  }

  async function removeCustomField(fieldId: string) {
    try {
      patchProject({
        customFields: await api.del(
          `/api/projects/${projectId}/custom-fields/${fieldId}`,
        ),
      });
    } catch (err) {
      fail(err, "Failed to remove custom field");
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
          canRemove={() => canDelete && categories.value.categories.length > 1}
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
              {/* Input renders a w-full wrapper, so it needs a sized box or it pushes
                  everything after it onto the next line */}
              <div className="w-[240px] shrink-0">
                <Input
                  value={cat.name}
                  aria-label="Category name"
                  placeholder="Category name..."
                  className="min-h-[38px] py-1.5"
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
                    className="focus-ring h-9 w-9 shrink-0 rounded-lg border border-border"
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
        title="Task templates"
        description="Pre-filled starting points for tasks people create often."
      >
        <ListEditor
          items={templates.value.templates}
          onChange={(next) => templates.set("templates", next)}
          keyOf={(t, i) => t._id || `new-${i}`}
          nameOf={(t) => t.name || "this template"}
          canRemove={() => canDelete}
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
                category: project.categories?.[0]?.name ?? CATEGORIES[0],
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
                <div className="w-[220px] shrink-0">
                  <Input
                    value={tpl.name}
                    aria-label="Template name"
                    placeholder="Template name..."
                    className="min-h-[38px] py-1.5"
                    onChange={(e) => editTemplate(i, { name: e.target.value })}
                  />
                </div>
                <span className="text-xs text-text-muted">{tpl.category}</span>
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
                      <select
                        value={tpl.category}
                        aria-label="Template category"
                        onChange={(e) =>
                          editTemplate(i, {
                            category: e.target.value as Category,
                          })
                        }
                        className="focus-ring w-full rounded-lg border border-border bg-bg-input px-3 py-2 text-sm"
                      >
                        {(
                          project.categories?.map((x) => x.name) || CATEGORIES
                        ).map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
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
